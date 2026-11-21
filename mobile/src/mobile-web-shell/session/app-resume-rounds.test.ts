import { describe, expect, it, vi } from 'vitest'

const appState = vi.hoisted(() => ({
  currentState: 'active',
  listeners: new Set<(state: string) => void>()
}))
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState
    },
    addEventListener: (_type: 'change', listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return { remove: () => appState.listeners.delete(listener) }
    }
  }
}))

const { askPagesAgain, latestAppResumeRound, onAppResumeRound } =
  await import('./app-resume-rounds')

function change(state: string): void {
  appState.listeners.forEach((listener) => listener(state))
}

describe('resume rounds', () => {
  it('asks every host on a return, but only the reloading host to confirm', () => {
    const hostA = vi.fn()
    const hostB = vi.fn()
    const stopA = onAppResumeRound('host-a', hostA)
    const stopB = onAppResumeRound('host-b', hostB)
    change('background')
    change('active')
    const returned = latestAppResumeRound()
    expect(hostA).toHaveBeenCalledWith(returned, false)
    expect(hostB).toHaveBeenCalledWith(returned, false)
    const confirm = askPagesAgain('host-a')
    expect(hostA).toHaveBeenLastCalledWith(confirm, true)
    expect(hostB).toHaveBeenCalledTimes(1)
    stopA()
    stopB()
  })
})
