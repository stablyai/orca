import {
  serializeBudgetedMobileSnapshot,
  serializeStableMobileRendererSnapshot,
  type MobileSnapshotByteBudget
} from './terminal-snapshot-publication'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import type {
  TerminalSubscribeBinaryState,
  TerminalSubscriptionArgs
} from './terminal-subscribe-types'

const MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS = 3_000

export type MobileSnapshotPreparationState = Pick<
  TerminalSubscribeBinaryState,
  'closed' | 'pendingOutput' | 'abortRendererMountWait' | 'lateRendererReadyPromise'
>

export async function prepareMobileTerminalSnapshot(
  {
    params,
    runtime,
    ptyId,
    missingHeadlessStateBeforeMobileFit,
    rendererMountRequestedBeforePty,
    serializerGenerationBeforeMobileFit
  }: Pick<
    TerminalSubscriptionArgs,
    | 'runtime'
    | 'ptyId'
    | 'missingHeadlessStateBeforeMobileFit'
    | 'rendererMountRequestedBeforePty'
    | 'serializerGenerationBeforeMobileFit'
  > & {
    params: Pick<TerminalSubscriptionArgs['params'], 'terminal'>
  },
  state: MobileSnapshotPreparationState,
  signal: AbortSignal,
  snapshotByteBudget?: MobileSnapshotByteBudget,
  firstRows?: number
) {
  // Fit first so the seed uses the phone-owned grid.
  const hydratedFromRenderer =
    missingHeadlessStateBeforeMobileFit &&
    (await runtime.maybeHydrateHeadlessFromRenderer?.(ptyId)) === true
  if (state.closed) {
    return null
  }
  let read = await runtime.readTerminal(params.terminal)
  let serialized = await serializeBudgetedMobileSnapshot(
    runtime,
    ptyId,
    snapshotByteBudget,
    firstRows
  )
  if (state.closed) {
    return null
  }
  // Missing model state, unlike blank text, means never-attached; null renderer answers fall back to mount wait even for stale host flags.
  const needsRendererScreen =
    missingHeadlessStateBeforeMobileFit &&
    !hydratedFromRenderer &&
    serialized?.source !== 'renderer'
  let rendererReady =
    needsRendererScreen &&
    (await runtime.serializeRendererTerminalBuffer(ptyId, { scrollbackRows: 0 })) !== null
  if (state.closed) {
    return null
  }
  const mountRequested =
    needsRendererScreen &&
    !rendererReady &&
    (rendererMountRequestedBeforePty || runtime.requestRendererTerminalTabMount(params.terminal))
  if (mountRequested) {
    // Idle PTYs emit no later bytes; wait for evidence this remount settled before replay.
    const mountWaitController = new AbortController()
    const abortMountWait = (): void => mountWaitController.abort()
    state.abortRendererMountWait = abortMountWait
    if (signal.aborted) {
      abortMountWait()
    } else {
      signal.addEventListener('abort', abortMountWait, { once: true })
    }
    const rendererReadyPromise = runtime
      .waitForRendererTerminalSerializer(
        ptyId,
        serializerGenerationBeforeMobileFit,
        undefined,
        mountWaitController.signal
      )
      .catch(() => false)
    const finishMountWait = (): void => {
      signal.removeEventListener('abort', abortMountWait)
      if (state.abortRendererMountWait === abortMountWait) {
        state.abortRendererMountWait = () => {}
      }
    }
    void rendererReadyPromise.then(finishMountWait, finishMountWait)
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    const initialDeadline = new Promise<boolean>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(false), MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS)
      if (typeof deadlineTimer.unref === 'function') {
        deadlineTimer.unref()
      }
    })
    rendererReady = await Promise.race([rendererReadyPromise, initialDeadline])
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    if (state.closed || signal.aborted) {
      return null
    }
    if (!rendererReady) {
      // Observe after the bounded initial response too, so an idle PTY can recover without output.
      state.lateRendererReadyPromise = rendererReadyPromise
    }
  }
  let rendererSeed: { seq?: number } | null = null
  if (rendererReady) {
    read = await runtime.readTerminal(params.terminal)
    const stableRendererSnapshot = await serializeStableMobileRendererSnapshot(
      runtime,
      ptyId,
      // Budget the scrollback frame actually sent below.
      snapshotByteBudget
    )
    if (state.closed) {
      return null
    }
    // Blank may mean unhydrated; seq-less snapshots are safe only with no pending bytes that replay could duplicate.
    if (
      stableRendererSnapshot?.data.length &&
      (typeof stableRendererSnapshot.seq === 'number' || state.pendingOutput.length === 0)
    ) {
      serialized = stableRendererSnapshot
      const trailingOutput = state.pendingOutput.flatMap((item) => {
        const output = getOutputAfterSnapshotSeq(item, stableRendererSnapshot.seq)
        const seq = item.meta?.seq
        return output && typeof seq === 'number' ? [{ data: output.data, seq }] : []
      })
      runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
        ptyId,
        stableRendererSnapshot,
        trailingOutput
      )
      rendererSeed = stableRendererSnapshot
    }
  }
  return { read, serialized, rendererSeed }
}

export async function readLateMobileRendererSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string,
  snapshotByteBudget: MobileSnapshotByteBudget | undefined,
  isCurrent: () => boolean
) {
  const recovery = await serializeStableMobileRendererSnapshot(runtime, ptyId, snapshotByteBudget)
  if (
    !isCurrent() ||
    !recovery?.data.length ||
    recovery.seq !== runtime.getPtyOutputSequence(ptyId)
  ) {
    return null
  }
  runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(ptyId, recovery)
  return recovery
}
