import { BridgeReplyRefusedError } from '../../mobile-web-shell/bridge/bridge-rpc-client'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import type { BridgePortPair } from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import { projectMobileRpcRequestParams } from '../../transport/mobile-rpc-request-projection'
import {
  checkpointKeys,
  checkpointListDifference,
  recordingDifferences
} from '../rpc-recording/golden-difference'
import type { Recording, RecordingScenario } from '../rpc-recording/recording-scenario'
import { captureError, captureValue } from '../rpc-recording/recording-values'
import { ordinalField } from './divergence-classes'
import { isKeyedObject, sameParams } from './divergence-evidence'

/** Only a matched injected request and its observed refusal can explain a recorded residual. */
export function absentResultExplainsResiduals(
  expected: Recording,
  actual: Recording,
  scenarios: readonly RecordingScenario[],
  pairs: readonly Pick<BridgePortPair<RpcClient>, 'toShell' | 'toPage' | 'diagnostics'>[],
  raw: Recording
): boolean {
  const list = checkpointListDifference(expected, actual)
  if (
    expected.scenario !== actual.scenario ||
    list.missing.length ||
    list.extra.length ||
    list.reordered
  ) {
    return false
  }
  const keys = checkpointKeys(expected)
  const actualKeys = checkpointKeys(actual)
  const residuals = recordingDifferences(expected, actual, true).filter(
    ({ field, path }) => !ordinalField(`${field}${path}`)
  )
  return (
    residuals.length > 0 &&
    residuals.every((difference) => {
      const before = expected.checkpoints[keys.indexOf(difference.checkpoint)]!.observation
      return scenarios.some((scenario, scenarioIndex) => {
        const pair = pairs[scenarioIndex]
        const senders = before.sender
        const rawCheckpoint = raw.checkpoints[actualKeys.indexOf(difference.checkpoint)]
        if (
          !rawCheckpoint ||
          rawCheckpoint.id !== actual.checkpoints[actualKeys.indexOf(difference.checkpoint)]!.id
        ) {
          return false
        }
        const bridgedSenders = rawCheckpoint.observation.sender
        if (!pair || !Array.isArray(senders) || !Array.isArray(bridgedSenders)) {
          return false
        }
        const prefix = scenarios.length > 1 ? `${scenario.id}:` : ''
        const occurrences = new Map<string, number>()
        let observedAt = -1
        const aliases = new Map<string, string>()
        for (const [index, step] of scenario.steps.entries()) {
          if ('checkpoint' in step) {
            const id = `${prefix}${step.checkpoint}`
            const occurrence = (occurrences.get(id) ?? 0) + 1
            occurrences.set(id, occurrence)
            if ((occurrence === 1 ? id : `${id}#${occurrence}`) === difference.checkpoint) {
              observedAt = index
            }
          }
        }
        if (difference.checkpoint === `${prefix}cleanup` && !occurrences.has(`${prefix}cleanup`)) {
          observedAt = scenario.steps.length
        }
        return scenario.steps.some((step, stepIndex) => {
          if ('bind' in step) {
            aliases.set(step.bind, aliases.get(step.request) ?? step.request)
          }
          if (
            stepIndex >= observedAt ||
            !('complete' in step) ||
            step.reject ||
            !isKeyedObject(step.reply) ||
            step.reply.ok !== true ||
            Object.hasOwn(step.reply, 'result')
          ) {
            return false
          }
          const executable = aliases.get(step.complete) ?? step.complete
          const matches = bridgedSenders.flatMap((entry) => {
            if (
              !isKeyedObject(entry) ||
              !isKeyedObject(entry.bridge) ||
              !Array.isArray(entry.bridge.posts)
            ) {
              return []
            }
            return entry.bridge.posts.flatMap((post) => {
              if (
                !isKeyedObject(post) ||
                post.parent !== entry.name ||
                !Array.isArray(post.children)
              ) {
                return []
              }
              return post.children.flatMap((child) =>
                isKeyedObject(child) && child.name === executable ? [{ entry, post, child }] : []
              )
            })
          })
          if (matches.length !== 1) {
            return false
          }
          const { entry: bridged, post, child } = matches[0]!
          const name = bridged.name
          const at = senders.findIndex((sender) => isKeyedObject(sender) && sender.name === name)
          const sender = senders[at]
          if (!isKeyedObject(sender) || !sameParams(sender.args, bridged.args)) {
            return false
          }
          const native = sender.settlement
          const rejected = bridged.settlement
          if (!isKeyedObject(native) || native.status !== 'fulfilled' || !isKeyedObject(rejected)) {
            return false
          }
          const payload =
            Array.isArray(before.payloads) &&
            before.payloads.find((value) => isKeyedObject(value) && value.name === name)
          if (!isKeyedObject(payload) || typeof payload.json !== 'string') {
            return false
          }
          const physical: unknown = JSON.parse(payload.json)
          if (!isKeyedObject(physical) || !sameParams(physical.params, step.params)) {
            return false
          }
          const nativeReply = captureValue({ ...step.reply, id: physical.id })
          if (!sameParams(native.value, nativeReply)) {
            return false
          }
          const method = child.method
          if (
            typeof method !== 'string' ||
            typeof post.json !== 'string' ||
            !isKeyedObject(child.frame)
          ) {
            return false
          }
          const request: unknown = JSON.parse(post.json)
          if (
            !isKeyedObject(request) ||
            request.id !== post.id ||
            request.method !== method ||
            physical.method !== method ||
            !sameParams(projectMobileRpcRequestParams(method, request.params), step.params)
          ) {
            return false
          }
          return pair.toPage.some((json) => {
            const frame: unknown = JSON.parse(json)
            const read = readBridgeHostMessage(json)
            if (
              read.ok ||
              !isKeyedObject(frame) ||
              frame.type !== 'reply' ||
              frame.id !== request.id ||
              !isKeyedObject(frame.payload) ||
              !sameParams(captureValue({ ...frame.payload, id: physical.id }), nativeReply) ||
              !pair.diagnostics.some(
                (diagnostic) => diagnostic.kind === 'refused' && diagnostic.refusal === read.refusal
              )
            ) {
              return false
            }
            const error = captureError(new BridgeReplyRefusedError(read.refusal))
            if (
              !sameParams(rejected, {
                status: 'rejected',
                startedAt: native.startedAt,
                settledAt: native.settledAt,
                error
              })
            ) {
              return false
            }
            if (
              difference.field === 'sender' &&
              difference.path.startsWith(`[${at}].settlement.`)
            ) {
              return true
            }
            // History copies this operation's error into the hook state and the panel's Text.
            const historyPath =
              (scenario.operation === 'aiVault.history-scan' &&
                difference.path === '.screenState.message') ||
              (scenario.operation === 'aiVault.history-screen' &&
                /^\.text\[\d+\]$/.test(difference.path))
            return (
              difference.field === 'state' &&
              historyPath &&
              ['status.get', 'aiVault.listSessions'].includes(method) &&
              difference.expected === `The host sent a reply this app could not read (${method})` &&
              difference.actual === new BridgeReplyRefusedError(read.refusal).message
            )
          })
        })
      })
    })
  )
}
