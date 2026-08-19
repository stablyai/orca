import { randomUUID } from 'node:crypto'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../types'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import {
  assertHerdrMigrationReady,
  encodeHerdrPtyId,
  type HerdrPtyBinding,
  type HerdrPtyIdentity,
  type HerdrPtyTarget
} from './herdr-pty-types'
import { startHerdrAgentIfRequested } from './herdr-pty-provider-runtime'
import type { HerdrRuntimeManager } from './herdr-runtime-manager'

export async function spawnHerdrPtyPane(args: {
  opts: PtySpawnOptions
  target: HerdrPtyTarget
  persistedIdentity: HerdrPtyIdentity | null
  fallback?: IPtyProvider
  sharedName?: string
  runtime: { manager: HerdrRuntimeManager; transport: HerdrHostTransport }
  bind: (
    input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>
  ) => HerdrPtyBinding
  waitForFirstFrame: (binding: HerdrPtyBinding) => Promise<{
    data: string
    frame: { width: number; height: number }
  } | null>
}): Promise<PtySpawnResult> {
  const { opts, target, persistedIdentity, runtime } = args
  await assertHerdrMigrationReady(target, args.fallback)
  await runtime.manager.reconcileProjectHost(target.graph)
  const sessionName = herdrSessionNameForProject(target.project, args.sharedName)
  let paneId = runtime.manager.getPaneId(
    sessionName,
    target.identity.projectId,
    target.identity.leafId
  )
  if (!paneId) {
    const worktree =
      target.graph.worktrees.find((candidate) => candidate.id === target.identity.worktreeId) ??
      target.graph.worktrees[0]
    if (worktree) {
      paneId = await runtime.manager.materializeLeafPane(
        target.project,
        target.identity.leafId,
        opts.cwd ?? '',
        worktree
      )
    }
  }
  const controller = await runtime.manager.controlProjectPane(
    target.project,
    target.identity.leafId,
    { cols: opts.cols, rows: opts.rows, takeover: true }
  )
  await target.activateHerdr?.()
  const resolvedPaneId =
    paneId ??
    runtime.manager.getPaneId(sessionName, target.identity.projectId, target.identity.leafId)
  const staleAttach =
    opts.attachOnly === true &&
    persistedIdentity !== null &&
    (resolvedPaneId === null || resolvedPaneId !== persistedIdentity.paneId)
  if (!resolvedPaneId || staleAttach) {
    controller.release()
    if (staleAttach) {
      throw new SessionNotFoundError(opts.sessionId ?? '')
    }
    throw new Error(`Herdr pane is not reconciled: ${target.identity.leafId}`)
  }
  const identity: HerdrPtyIdentity = {
    ...target.identity,
    version: 2,
    paneId: resolvedPaneId
  }
  const id = encodeHerdrPtyId(identity)
  const incarnationId = opts.expectedIncarnationId ?? randomUUID()
  const binding = args.bind({
    id,
    controller,
    transport: runtime.transport,
    identity,
    paneId: resolvedPaneId,
    sessionName,
    incarnationId,
    cwd: opts.cwd ?? '',
    cols: opts.cols,
    rows: opts.rows
  })
  const firstFrame = await args.waitForFirstFrame(binding)
  await startHerdrAgentIfRequested({
    sessionId: opts.sessionId,
    launchAgent: opts.launchAgent,
    command: opts.command,
    sessionName,
    leafId: target.identity.leafId,
    paneId: resolvedPaneId,
    request: async (name, method, params) =>
      unwrapHerdrResponse(await runtime.transport.request(name, method, params)),
    writeCommand: (text) => controller.write(text)
  })
  return {
    id,
    isReattach: !!opts.sessionId,
    ...(incarnationId ? { incarnationId } : {}),
    ...(firstFrame
      ? {
          snapshot: firstFrame.data,
          snapshotCols: firstFrame.frame.width,
          snapshotRows: firstFrame.frame.height
        }
      : {})
  }
}
