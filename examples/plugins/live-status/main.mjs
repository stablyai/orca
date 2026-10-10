// Sample worker for status-bar items and the live panel channel. Runs in the
// out-of-process plugin worker (plain Node). Orca starts it as soon as a window
// shows the status bar, because its items need a worker to fill them.
let ticks = 0
let resets = 0
let timer = null

function state() {
  return { type: 'state', ticks, resets }
}

export default function activate(orca) {
  const publish = async () => {
    // Each update replaces the item; Orca coalesces bursts to 4 per second.
    await orca.statusBar.update('pulse', {
      text: `Pulse ${ticks}`,
      tooltip: `Seconds since the last reset (${resets} resets so far). Click to reset.`,
      severity: ticks >= 60 ? 'warning' : 'normal'
    })
    // Dropped (delivered: false) while the panel is closed.
    await orca.panels.postMessage('live', state())
  }
  const reset = async () => {
    ticks = 0
    resets += 1
    await publish()
    return state()
  }

  orca.commands.register('live-status-reset', reset)

  // The panel asks for a snapshot when it mounts; Orca sends no open signal.
  orca.panels.onMessage('live', async (message) => {
    if (message?.type === 'ready') {
      await orca.panels.postMessage('live', { ...state(), snapshot: true })
    } else if (message?.type === 'reset') {
      await reset()
    }
  })

  void orca.statusBar.update('open-panel', {
    text: 'Live panel',
    tooltip: 'Open the Live Status panel'
  })
  void publish()
  timer = setInterval(() => {
    ticks += 1
    publish().catch((error) => orca.log(`publish failed: ${error.message}`))
  }, 1000)
}

export function deactivate() {
  clearInterval(timer)
}
