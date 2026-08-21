// Sample MCode plugin worker entry. Runs inside the out-of-process plugin
// worker (plain Node, no Electron), forked lazily on the first trigger. The
// default export receives the `mcode` API: command registration, event
// handlers, and the capability-gated host API.
export default function activate(mcode) {
  mcode.commands.register('hello-ping', async (args) => {
    const stored = await mcode.host.call('storage.get', { key: 'pings' })
    const count = (typeof stored?.value === 'number' ? stored.value : 0) + 1
    await mcode.host.call('storage.set', { key: 'pings', value: count })
    return { pong: true, count, args: args ?? null }
  })

  mcode.events.on('worktree.created', async (payload) => {
    mcode.log(`worktree created: ${payload.worktreeId} at ${payload.path}`)
    await mcode.host.call('notifications.show', {
      title: 'Worktree created',
      body: payload.path
    })
  })

  mcode.events.on('agent.status.changed', (payload) => {
    mcode.log(`agent status: ${payload.state} in ${payload.worktreeId ?? 'unknown worktree'}`)
  })
}
