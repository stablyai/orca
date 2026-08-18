import { randomUUID } from 'node:crypto'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import type { PtyDataEvent, PtySpawnResult } from '../../types'
import { assertHerdrMigrationReady, decodeHerdrPtyId } from './herdr-pty-types'
import type { HerdrPtyBinding, HerdrPtyIdentity, HerdrPtyTarget } from './herdr-pty-types'
export { decodeHerdrPtyId, encodeHerdrPtyId } from './herdr-pty-types'
import type { PtySpawnOptions } from '../../types'
import {
  HerdrRuntimeManager,
  type HerdrLivePaneListener,
  type HerdrPaneExitListener,
  type HerdrSurfaceSync
} from './herdr-runtime-manager'
import { Buffer } from 'node:buffer'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  unwrapHerdrResponse,
  type HerdrHostTransport,
  type HerdrTerminalFrame
} from './herdr-runtime-contract'
import { bytesFromTerminalLogicalKey } from '../../../../shared/terminal-logical-key'

function decodeFrame(frame: HerdrTerminalFrame): string {
  return Buffer.from(frame.bytes, 'base64').toString('utf8')
}

export async function waitForFirstHerdrFrame(
  binding: HerdrPtyBinding,
  callbacks: {
    emitData(payload: { id: string; data: string; sequenceChars: number }): void
    emitExit(payload: { id: string; code: number }): void
    detach(): void
  }
): Promise<{ frame: HerdrTerminalFrame; data: string } | null> {
  return await new Promise((resolve, reject) => {
    let first = true
    const timeout = setTimeout(() => {
      first = false
      resolve(null)
    }, 2_000)
    binding.unsubscribe.push(
      binding.controller.onFrame((frame) => {
        const data = decodeFrame(frame)
        binding.cols = frame.width
        binding.rows = frame.height
        if (first) {
          first = false
          clearTimeout(timeout)
          binding.snapshot = data
          resolve({ frame, data })
          return
        }
        if (frame.full) {
          const previous = binding.snapshot
          binding.snapshot = data
          const appended = data.startsWith(previous)
          const delta = appended ? data.slice(previous.length) : data
          if (!delta) {
            return
          }
          const out = appended ? delta : `\x1b[0m\x1b[2J\x1b[H${data}`
          binding.sequenceChars += out.length
          callbacks.emitData({ id: binding.id, data: out, sequenceChars: binding.sequenceChars })
          return
        }
        binding.snapshot = `${binding.snapshot}${data}`
        if (binding.snapshot.length > TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT) {
          binding.snapshot = binding.snapshot.slice(
            binding.snapshot.length - TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT
          )
        }
        binding.sequenceChars += data.length
        callbacks.emitData({ id: binding.id, data, sequenceChars: binding.sequenceChars })
      }),
      binding.controller.onClosed(() => {
        if (binding.detached) {
          return
        }
        if (first) {
          first = false
          clearTimeout(timeout)
          callbacks.detach()
          reject(new Error('Herdr terminal controller closed before its first frame'))
          return
        }
        callbacks.detach()
        callbacks.emitExit({ id: binding.id, code: 0 })
      })
    )
  })
}

const HERDR_AGENT_KINDS = new Set([
  'amp',
  'claude',
  'cline',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'droid',
  'gemini',
  'grok',
  'hermes',
  'kilo',
  'kimi',
  'kiro',
  'omp',
  'opencode',
  'pi'
])

export function herdrAgentKind(agent: TuiAgent | undefined): string | null {
  if (!agent || !HERDR_AGENT_KINDS.has(agent)) {
    return null
  }
  return agent
}

export function herdrAgentName(leafId: string): string {
  const slug = leafId.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const body = (slug || 'pane').slice(0, 30)
  return `o${body}`.slice(0, 32)
}

export async function startHerdrAgentIfRequested(args: {
  sessionId?: string
  launchAgent?: TuiAgent
  command?: string
  sessionName: string
  leafId: string
  paneId: string
  request: (sessionName: string, method: string, params: unknown) => Promise<unknown>
  writeCommand: (text: string) => void
}): Promise<void> {
  if (args.sessionId) {
    return
  }
  const kind = herdrAgentKind(args.launchAgent)
  if (kind) {
    await args.request(args.sessionName, 'agent.start', {
      name: herdrAgentName(args.leafId),
      kind,
      pane_id: args.paneId
    })
    return
  }
  if (args.command) {
    args.writeCommand(`${args.command}\r`)
  }
}

function bindController(
  input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>
): HerdrPtyBinding {
  return {
    ...input,
    sequenceChars: 0,
    snapshot: '',
    detached: false,
    unsubscribe: []
  }
}

function detachBinding(binding: HerdrPtyBinding, bindings: Map<string, HerdrPtyBinding>): void {
  if (binding.detached) {
    return
  }
  binding.detached = true
  for (const unsubscribe of binding.unsubscribe.splice(0)) {
    unsubscribe()
  }
  binding.controller.release()
  bindings.delete(binding.id)
}

function disposeProvider(
  bindings: Map<string, HerdrPtyBinding>,
  managers: Map<string, HerdrRuntimeManager>
): void {
  for (const binding of bindings.values()) {
    binding.detached = true
    for (const unsubscribe of binding.unsubscribe.splice(0)) {
      unsubscribe()
    }
    binding.controller.release()
    bindings.delete(binding.id)
  }
  for (const manager of managers.values()) {
    manager.dispose()
  }
  managers.clear()
}

export function getRuntime(
  target: HerdrPtyTarget,
  managers: Map<string, HerdrRuntimeManager>,
  transportForTarget: (target: HerdrPtyTarget) => HerdrHostTransport,
  sharedName: (() => string | undefined) | undefined,
  onLivePaneIds?: HerdrLivePaneListener,
  surfaceSync?: HerdrSurfaceSync,
  onPaneExited?: HerdrPaneExitListener
): {
  manager: HerdrRuntimeManager
  transport: HerdrHostTransport
} {
  const transport = transportForTarget(target)
  let manager = managers.get(target.identity.hostId)
  if (!manager) {
    manager = new HerdrRuntimeManager(
      transport,
      sharedName,
      onLivePaneIds,
      surfaceSync,
      onPaneExited
    )
    managers.set(target.identity.hostId, manager)
  }
  return { manager, transport }
}

export function createBinding(
  input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>,
  bindings: Map<string, HerdrPtyBinding>
): HerdrPtyBinding {
  const previous = bindings.get(input.id)
  if (previous) {
    detachBinding(previous, bindings)
  }
  const binding = bindController(input)
  bindings.set(input.id, binding)
  return binding
}

export function awaitFirstFrame(
  binding: HerdrPtyBinding,
  emitData: (payload: { id: string; data: string; sequenceChars: number }) => void,
  emitExit: (payload: { id: string; code: number }) => void,
  detach: () => void
): Promise<{ frame: HerdrTerminalFrame; data: string } | null> {
  return waitForFirstHerdrFrame(binding, { emitData, emitExit, detach })
}

export function releaseBinding(
  binding: HerdrPtyBinding,
  bindings: Map<string, HerdrPtyBinding>
): void {
  detachBinding(binding, bindings)
}

export function disposeAll(
  bindings: Map<string, HerdrPtyBinding>,
  managers: Map<string, HerdrRuntimeManager>,
  disposeBase: () => void
): void {
  disposeProvider(bindings, managers)
  disposeBase()
}

export function retireMissingHerdrPanes(
  bindings: Map<string, HerdrPtyBinding>,
  sessionName: string,
  livePaneIds: ReadonlySet<string>,
  retire: (binding: HerdrPtyBinding) => void
): void {
  for (const binding of bindings.values()) {
    if (binding.sessionName !== sessionName || livePaneIds.has(binding.paneId)) {
      continue
    }
    retire(binding)
  }
}

export async function sendHerdrNamedKey(binding: HerdrPtyBinding, name: string): Promise<void> {
  try {
    unwrapHerdrResponse(
      await binding.transport.request(binding.sessionName, 'pane.send_keys', {
        pane_id: binding.paneId,
        keys: [name]
      })
    )
  } catch (error: unknown) {
    const bytes = bytesFromTerminalLogicalKey(name)
    if (bytes !== null) {
      binding.controller.write(bytes)
      return
    }
    console.warn(`[herdr] pane.send_keys ${name} failed:`, error)
  }
}

export async function closeHerdrBindingSurface(binding: HerdrPtyBinding): Promise<void> {
  const { transport, sessionName, paneId } = binding
  try {
    const pane = unwrapHerdrResponse<{ pane: { workspace_id?: string } }>(
      await transport.request(sessionName, 'pane.get', { pane_id: paneId })
    ).pane
    const workspaceId = pane.workspace_id
    if (workspaceId) {
      const listed = unwrapHerdrResponse<{ panes: { pane_id: string }[] }>(
        await transport.request(sessionName, 'pane.list', { workspace_id: workspaceId })
      ).panes
      if (listed.length <= 1) {
        unwrapHerdrResponse(
          await transport.request(sessionName, 'workspace.close', { workspace_id: workspaceId })
        )
        return
      }
    }
  } catch {
    // Last-pane lookup failed; close the pane directly.
  }
  unwrapHerdrResponse(await transport.request(sessionName, 'pane.close', { pane_id: paneId }))
}

export function retireExitedHerdrPane(
  bindings: Map<string, HerdrPtyBinding>,
  sessionName: string,
  paneId: string,
  emitExit: (payload: { id: string; code: number }) => void
): void {
  for (const binding of bindings.values()) {
    if (binding.sessionName !== sessionName || binding.paneId !== paneId || binding.detached) {
      continue
    }
    void closeHerdrBindingSurface(binding).catch(() => undefined)
    releaseBinding(binding, bindings)
    emitExit({ id: binding.id, code: 0 })
  }
}

export function emitHerdrPtyData(
  listeners: Set<(payload: PtyDataEvent) => void>,
  payload: PtyDataEvent
): void {
  for (const listener of listeners) {
    listener(payload)
  }
}

export function emitHerdrPtyExit(
  listeners: Set<(payload: { id: string; code: number; incarnationId?: string }) => void>,
  bindings: Map<string, HerdrPtyBinding>,
  payload: { id: string; code: number; incarnationId?: string }
): void {
  const incarnationId = payload.incarnationId ?? bindings.get(payload.id)?.incarnationId
  const event = incarnationId ? { ...payload, incarnationId } : payload
  for (const listener of listeners) {
    listener(event)
  }
}

export function emitHerdrPtyReplay(
  listeners: Set<(payload: { id: string; data: string }) => void>,
  payload: { id: string; data: string }
): void {
  for (const listener of listeners) {
    listener(payload)
  }
}

export async function attachHerdrPty(args: {
  id: string
  bindings: Map<string, HerdrPtyBinding>
  resolveTarget: (
    opts: PtySpawnOptions,
    identity: HerdrPtyIdentity
  ) => Promise<HerdrPtyTarget | null>
  runtimeFor: (target: HerdrPtyTarget) => {
    manager: HerdrRuntimeManager
    transport: HerdrHostTransport
  }
  sharedName?: () => string | undefined
  bind: (
    input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>
  ) => HerdrPtyBinding
  waitForFirstFrame: (binding: HerdrPtyBinding) => Promise<{ data: string } | null>
  emitReplay: (payload: { id: string; data: string }) => void
}): Promise<Pick<PtySpawnResult, 'providerSequence'> | void> {
  if (args.bindings.has(args.id)) {
    return
  }
  const identity = decodeHerdrPtyId(args.id)
  if (!identity) {
    throw new Error(`Invalid herdr PTY ID: ${args.id}`)
  }
  const target = await args.resolveTarget(
    {
      cols: 80,
      rows: 24,
      sessionId: args.id,
      worktreeId: identity.worktreeId,
      tabId: identity.tabId,
      paneKey: `${identity.tabId}:${identity.leafId}`
    },
    identity
  )
  if (!target) {
    throw new Error(`Cannot resolve persisted Herdr PTY ${args.id}`)
  }
  await assertHerdrMigrationReady(target)
  const runtime = args.runtimeFor(target)
  await runtime.manager.reconcileProjectHost(target.graph)
  const controller = await runtime.manager.controlProjectPane(target.project, identity.leafId, {
    cols: 80,
    rows: 24,
    takeover: true
  })
  await target.activateHerdr?.()
  const sessionName = herdrSessionNameForProject(target.project, args.sharedName?.())
  const paneId =
    runtime.manager.getPaneId(sessionName, identity.projectId, identity.leafId) ?? identity.paneId
  if (!paneId) {
    controller.release()
    throw new Error(`Herdr pane is not reconciled: ${identity.leafId}`)
  }
  const binding = args.bind({
    id: args.id,
    controller,
    transport: runtime.transport,
    identity,
    paneId,
    sessionName,
    incarnationId: randomUUID(),
    cwd: '',
    cols: 80,
    rows: 24
  })
  const firstFrame = await args.waitForFirstFrame(binding)
  if (firstFrame) {
    args.emitReplay({ id: args.id, data: firstFrame.data })
  }
}

export function killAllHerdrBindings(bindings: Map<string, HerdrPtyBinding>): void {
  for (const binding of bindings.values()) {
    void closeHerdrBindingSurface(binding).catch(() => undefined)
  }
  bindings.clear()
}
