// OMP activity snapshots and dialog calls feed the managed status transport.
export function getOmpStatusLifecycleSourceLines(): string[] {
  return `
let ompUiPromptDepth = 0
let ompDialogTracking: { epoch: number; depth: number; context: unknown; post: typeof post; activity: typeof readOmpActivity; syncDepth: (depth: number) => void } | null = null
function readOmpActivity(ctx): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  try {
    if (typeof ctx?.isIdle === 'function') snapshot.is_idle = ctx.isIdle() === true
    if (typeof ctx?.hasPendingMessages === 'function') snapshot.has_pending_messages = ctx.hasPendingMessages() === true
    if (typeof ctx?.getAsyncJobSnapshot === 'function') {
      const jobs = ctx.getAsyncJobSnapshot()
      if (Array.isArray(jobs?.running)) snapshot.has_active_jobs = jobs.running.length > 0
    }
  } catch {
    return { is_idle: false, has_pending_messages: true, has_active_jobs: true }
  }
  return snapshot
}

function readOmpTurnOutcome(messages): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    if (message.stopReason === 'error') return 'failure'
    if (message.stopReason === 'aborted') return 'cancellation'
    if (message.stopReason === 'stop') return 'success'
    return undefined
  }
  return undefined
}

function invalidateOmpUiDialogs(): void {
  ompUiPromptDepth = 0
  if (!ompDialogTracking) return
  ompDialogTracking.epoch++
  ompDialogTracking.depth = 0
}

function installOmpUiTracking(ctx): void {
  if (!isOmpRuntime() || ctx?.hasUI !== true || !ctx.ui) return
  try {
    const ui = ctx.ui
    const key = Symbol.for('orca.omp.status-ui-dialogs')
    let tracking = Reflect.get(ui, key)
    if (!tracking) {
      tracking = { epoch: 0, depth: 0, context: ctx, post, activity: readOmpActivity, syncDepth: (depth) => { ompUiPromptDepth = depth } }
      if (!Reflect.defineProperty(ui, key, { value: tracking, configurable: true })) return
      for (const name of ['select', 'confirm', 'input', 'askDialog', 'custom', 'editor']) {
        // OMP handler proxies expose the shared UI's own descriptors, not their delegated methods.
        const descriptor = Object.getOwnPropertyDescriptor(ui, name)
        if (!descriptor || typeof descriptor.value !== 'function' || descriptor.writable === false) continue
        const original = descriptor.value
        const wrapped = async function (...args) {
          const epoch = tracking.epoch
          tracking.depth++
          tracking.syncDepth(tracking.depth)
          if (tracking.depth === 1) tracking.post('ui_prompt_start')
          try {
            return await original.apply(this, args)
          } finally {
            // A dialog from a replaced session or run cannot change the current session's row.
            if (epoch === tracking.epoch) {
              tracking.depth--
              tracking.syncDepth(tracking.depth)
              if (tracking.depth === 0) tracking.post('ui_prompt_end', tracking.activity(tracking.context))
            }
          }
        }
        Reflect.defineProperty(ui, name, { ...descriptor, value: wrapped })
      }
    }
    tracking.context = ctx
    tracking.post = post
    tracking.activity = readOmpActivity
    tracking.syncDepth = (depth) => { ompUiPromptDepth = depth }
    ompDialogTracking = tracking
    ompUiPromptDepth = tracking.depth
  } catch {
    // Status instrumentation must not prevent an agent UI call.
    return
  }
}
`
    .trim()
    .split('\n')
}

export function getOmpStatusLifecycleHandlerSourceLines(): string[] {
  return [
    "  for (const name of ['auto_retry_start', 'auto_retry_end', 'auto_compaction_start', 'auto_compaction_end', 'retry_fallback_applied', 'retry_fallback_succeeded']) {",
    '    onStatus(name, (event, ctx) => {',
    '      if (!isOmpRuntime()) return',
    '      updateRuntimeOmpSessionMetadata(ctx)',
    '      post(name, { ...event, ...readOmpActivity(ctx) })',
    '    })',
    '  }'
  ]
}
