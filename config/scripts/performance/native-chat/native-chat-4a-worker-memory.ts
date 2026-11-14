import type { ElectronApplication } from '@stablyai/playwright-test'

/** Process-wide NodeWorker inventory; read-only Runtime.evaluate, with no pause on worker start. */
export async function workerMemory(app: ElectronApplication) {
  return app.evaluate(async () => {
    const { Session } = process.getBuiltinModule('node:inspector')
    const session = new Session()
    session.connect()
    type Message = { id?: number; result?: { result?: { value?: string } }; error?: unknown }
    const pending = new Map<number, (message: Message) => void>()
    const targets = new Map<string, { title: string; url: string }>()
    const errors: string[] = []
    let sequence = 0
    let detached = false
    const post = (method: string, params: Record<string, unknown>): Promise<void> =>
      new Promise((resolve, reject) => {
        session.post(method, params, (error) => (error ? reject(error) : resolve()))
      })
    session.on('NodeWorker.attachedToWorker', ({ params }) => {
      targets.set(params.sessionId, { title: params.workerInfo.title, url: params.workerInfo.url })
    })
    session.on('NodeWorker.detachedFromWorker', () => {
      detached = true
    })
    session.on('NodeWorker.receivedMessageFromWorker', ({ params }) => {
      const message: Message = JSON.parse(params.message)
      if (message.id) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    })
    try {
      await post('NodeWorker.enable', { waitForDebuggerOnStart: false })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const workers = await Promise.all(
        [...targets].map(async ([sessionId, info]) => {
          try {
            const message = await new Promise<Message>((resolve, reject) => {
              const id = ++sequence
              const timeout = setTimeout(() => {
                pending.delete(id)
                reject(new Error('worker memory timeout'))
              }, 1500)
              pending.set(id, (message) => {
                clearTimeout(timeout)
                resolve(message)
              })
              const expression = `JSON.stringify((()=>{const w=process.getBuiltinModule('node:worker_threads');const d=w.workerData;return {threadId:w.threadId,role:d && 'backpressureFrames' in d ? 'checkpoint' : d && 'originalFilename' in d ? 'journal-reader' : d && 'stateDirectory' in d ? 'journal-writer' : /journal-sql-reader/.test(process.argv[1]||'') ? 'journal-reader' : /journal-sql-worker/.test(process.argv[1]||'') ? 'journal-writer' : 'other',...process.memoryUsage()}})())`
              void post('NodeWorker.sendMessageToWorker', {
                sessionId,
                message: JSON.stringify({
                  id,
                  method: 'Runtime.evaluate',
                  params: { expression, returnByValue: true }
                })
              }).catch((error: unknown) => {
                clearTimeout(timeout)
                pending.delete(id)
                reject(error)
              })
            })
            if (message.error || typeof message.result?.result?.value !== 'string') {
              throw new Error('worker memory unavailable')
            }
            return { sessionId, ...info, memory: JSON.parse(message.result.result.value) }
          } catch (error) {
            errors.push(`${sessionId}: ${String(error)}`)
            return { sessionId, ...info, memory: null }
          }
        })
      )
      if (detached || workers.length !== targets.size) {
        errors.push('worker inventory changed during snapshot')
      }
      const roleCounts: Record<string, number> = {}
      for (const worker of workers) {
        const role = String(worker.memory?.role ?? 'unavailable')
        roleCounts[role] = (roleCounts[role] ?? 0) + 1
      }
      return {
        workers,
        count: targets.size,
        roleCounts,
        errors,
        complete: errors.length === 0,
        processRssBytes: process.memoryUsage().rss,
        rssScope:
          'worker memory.rss is shared process RSS; never sum or treat as per-thread resident bytes'
      }
    } finally {
      session.disconnect()
    }
  })
}
