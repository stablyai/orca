// Sample Orca plugin worker entry. Runs inside the out-of-process plugin
// worker (plain Node, no Electron), forked lazily on the first trigger. The
// default export receives the `orca` API: command registration, event
// handlers, and the capability-gated host API.
export default function activate(orca) {
  orca.commands.register('hello-ping', async (args) => {
    const stored = await orca.host.call('storage.get', { key: 'pings' })
    const count = (typeof stored?.value === 'number' ? stored.value : 0) + 1
    await orca.host.call('storage.set', { key: 'pings', value: count })
    return { pong: true, count, args: args ?? null }
  })

  orca.events.on('worktree.created', async (payload) => {
    orca.log(`worktree created: ${payload.worktreeId} at ${payload.path}`)
    await orca.host.call('notifications.show', {
      title: 'Worktree created',
      body: payload.path
    })
  })

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agent status: ${payload.state} in ${payload.worktreeId ?? 'unknown worktree'}`)
  })
}
