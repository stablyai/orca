export type AgentAwakePowerMonitor = {
  on: (event: 'resume' | 'on-battery' | 'on-ac', listener: () => void) => unknown
  off: (event: 'resume' | 'on-battery' | 'on-ac', listener: () => void) => unknown
}

export function subscribeAgentAwakePowerMonitor(
  source: AgentAwakePowerMonitor,
  platform: NodeJS.Platform,
  refresh: (reason: string) => void
): () => void {
  const listeners: ['resume' | 'on-battery' | 'on-ac', () => void][] = [
    ['resume', () => refresh('power-resume')]
  ]
  if (platform === 'darwin') {
    listeners.push(
      ['on-battery', () => refresh('power-source-change')],
      ['on-ac', () => refresh('power-source-change')]
    )
  }
  for (const [event, listener] of listeners) {
    source.on(event, listener)
  }
  return () => {
    for (const [event, listener] of listeners) {
      source.off(event, listener)
    }
  }
}
