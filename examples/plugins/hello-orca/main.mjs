// Sample Orca plugin worker entry. Runs inside the out-of-process plugin
// worker (plain Node, no Electron), forked lazily on the first trigger. The
// default export receives the `orca` API: command registration, event
// handlers, and the capability-gated host API.
export default function activate(orca) {
  orca.commands.register('hello-ping', async () => {
    const stored = await orca.host.call('storage.get', { key: 'pings' })
    const count = (typeof stored?.value === 'number' ? stored.value : 0) + 1
    await orca.host.call('storage.set', { key: 'pings', value: count })
    // A string result is shown as-is in Orca; objects are shown as JSON.
    return count === 1 ? 'Pong! First ping.' : `Pong! ${count} pings so far.`
  })

  orca.events.on('workspace.created', async (payload) => {
    orca.log(`${payload.kind} created: ${payload.workspaceId} at ${payload.path}`)
    await orca.host.call('notifications.show', {
      title: 'Workspace created',
      body: payload.path
    })
  })

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agent status: ${payload.state} in ${payload.workspaceId ?? 'unknown workspace'}`)
  })
}
