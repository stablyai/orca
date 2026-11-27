// Record delivered report bytes, so grading checks what arrived.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  ARTIFACT_SHARING_DISABLED_CODE,
  ARTIFACT_SHARING_DISABLED_MESSAGE
} from '../../shared/artifacts/artifact-sharing-gate'
import type { BotItem } from '../../shared/bots/bot-items'
import { RuntimeClientError } from '../runtime/connection/types'
import type { EvalHostState } from './bot-automation-eval-host'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'
import {
  matches,
  normalizeCommandPositionals,
  parseArgs,
  resolveHelpPath,
  validateCommandAndFlags
} from '../arguments/args'
import { ARTIFACT_COMMAND_SPECS } from '../specs/artifacts'

export const EVAL_SHARE_URL = 'https://share.onorca.dev/a/eval-report'
export const EVAL_UPLOAD_PREFIX = 'data:application/x-orca-eval-upload,'

export type EvalArtifactInvocation = { id: string; argv: string[] }

function isPublishingInvocation(command: string[]): boolean {
  try {
    const parsed = normalizeCommandPositionals(
      ARTIFACT_COMMAND_SPECS,
      parseArgs(
        command,
        ARTIFACT_COMMAND_SPECS.map((spec) => spec.path),
        ARTIFACT_COMMAND_SPECS
      )
    )
    if (
      resolveHelpPath(parsed) !== null ||
      !['share', 'update'].some((verb) => matches(parsed.commandPath, ['artifacts', verb]))
    ) {
      return false
    }
    validateCommandAndFlags(ARTIFACT_COMMAND_SPECS, parsed)
    return true
  } catch {
    return false
  }
}

/** Accept only the stand-in's upload slots; every other request uses the original fetch. */
export function installDeliveryUploads(io: Pick<StandInIo, 'record'>): void {
  const request = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (!url.startsWith(EVAL_UPLOAD_PREFIX)) {
      return request(input, init)
    }
    if (init?.method !== 'POST' || !(init.body instanceof Blob)) {
      return new Response(null, { status: 400 })
    }
    io.record({
      kind: 'write',
      method: 'connector.upload',
      params: { postId: decodeURIComponent(url.slice(EVAL_UPLOAD_PREFIX.length)) },
      result: { text: (await init.body.text()).slice(0, 64 * 1024), size: init.body.size }
    })
    return new Response(null, { status: 200 })
  }
}

/** A file the bot sent, as it was on disk when it went: its name and its words. */
export type EvalSentFile = { name: string; text: string }

export function sentFiles(paths: readonly string[]): EvalSentFile[] {
  return paths.map((path) => ({
    name: basename(path),
    text: (() => {
      try {
        return readFileSync(path, 'utf8').slice(0, 64 * 1024)
      } catch {
        return ''
      }
    })()
  }))
}

function sharedItem(params: Record<string, unknown>) {
  const now = new Date().toISOString()
  return {
    shareUrl: EVAL_SHARE_URL,
    artifact: {
      version: 1,
      slug: 'eval-report',
      title: null,
      originalFileName: typeof params.fileName === 'string' ? params.fileName : null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
      byteSize: 1,
      deletedAt: null
    }
  }
}

function item(state: EvalHostState, number: number): BotItem {
  const seeded = state.items?.find((entry) => entry.number === number)
  if (!seeded) {
    throw new RuntimeClientError('not_found', `There is no item ${number}.`)
  }
  const bot = state.bots[0]!
  return {
    uid: `item-${number}`,
    number,
    owner: { botId: bot.id, name: bot.name },
    title: seeded.title,
    description: null,
    doneMeans: null,
    status: 'working',
    chat: { id: 'chat-home', kind: 'home', title: null },
    madeBy: null,
    question: null,
    closeNote: null,
    wait: null,
    links: [],
    version: 1,
    lastEventId: 'e1',
    othersLastEventId: 'e1',
    snoozedUntil: null,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    closedAt: null
  }
}

/** Undefined when the scenario sets up neither, so other hosts answer as before. */
export function serveDeliveries(
  state: EvalHostState,
  method: string,
  params: Record<string, unknown>,
  io: StandInIo,
  invocation?: EvalArtifactInvocation
): unknown {
  if (state.items && method === 'bots.items.show') {
    return { item: item(state, Number(String(params.item).replace(/^#/, ''))), events: [] }
  }
  if (state.items && method === 'bots.items.list') {
    return {
      botId: state.bots[0]!.id,
      botName: state.bots[0]!.name,
      items: state.items.map((entry) => item(state, entry.number)),
      counts: { working: state.items.length }
    }
  }
  if (method === 'bots.items.comment' && state.items) {
    const commented = item(state, Number(String(params.item).replace(/^#/, '')))
    const files = Array.isArray(params.files) ? params.files.map(String) : []
    if (files.length && state.filesRefused) {
      throw new RuntimeClientError('attachment_failed', 'The item did not take the file.')
    }
    io.record({
      kind: 'write',
      method,
      params,
      result: { item: commented.number, files: sentFiles(files) }
    })
    return { item: commented, eventId: 'e2' }
  }
  if (state.artifactSharing === undefined) {
    return undefined
  }
  const enabled = state.artifactSharing === 'on'
  const attempt = (phase: 'preflight' | 'publish') => {
    if (invocation) {
      io.record({
        kind: 'write',
        method: 'artifacts.attempt',
        params: { invocationId: invocation.id, argv: invocation.argv, phase },
        result: { refusal: enabled ? null : ARTIFACT_SHARING_DISABLED_CODE }
      })
    }
  }
  if (method === 'settings.get') {
    if (invocation && isPublishingInvocation(invocation.argv)) {
      attempt('preflight')
    }
    return { settings: { artifactSharingEnabled: enabled } }
  }
  if (method !== 'artifacts.share') {
    return undefined
  }
  attempt('publish')
  if (!enabled) {
    throw new RuntimeClientError(ARTIFACT_SHARING_DISABLED_CODE, ARTIFACT_SHARING_DISABLED_MESSAGE)
  }
  io.record({
    kind: 'write',
    method,
    params: { fileName: params.fileName, content: params.content },
    result: { shareUrl: EVAL_SHARE_URL }
  })
  return { status: 'ok', value: sharedItem(params) }
}
