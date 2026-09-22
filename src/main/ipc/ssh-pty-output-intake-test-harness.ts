import { vi } from 'vitest'
import {
  SshPtyOutputIntake,
  type SshPtyOutputDataEvent,
  type SshPtyOutputIntakeDependencies
} from './ssh-pty-output-intake'

export function sshPtyOutputEvent(
  overrides: Partial<SshPtyOutputDataEvent> = {}
): SshPtyOutputDataEvent {
  return {
    id: 'pty-1',
    data: 'aaaa',
    providerGeneration: 1,
    ptyIncarnation: 'incarnation-1',
    rawLength: 4,
    transformed: false,
    ...overrides
  }
}

export function createSshPtyOutputIntakeHarness(
  overrides: Partial<SshPtyOutputIntakeDependencies> = {},
  options: ConstructorParameters<typeof SshPtyOutputIntake>[1] = {}
) {
  let sequence = 0
  const completions: ReturnType<typeof deferred>[] = []
  const order: string[] = []
  const dependencies: SshPtyOutputIntakeDependencies = {
    getModelSequence: () => sequence,
    acceptModel: (input) => {
      order.push(`model:${input.data}`)
      sequence += input.rawLength
      const completion = deferred()
      completions.push(completion)
      return { sequence, completion: completion.promise }
    },
    project: (input) => order.push(`project:${input.data}`),
    prepareExit: vi.fn(),
    finalizeExit: () => order.push('exit'),
    pauseProvider: vi.fn(() => true),
    resumeProvider: vi.fn(),
    closeProvider: vi.fn(),
    ...overrides
  }
  return {
    intake: new SshPtyOutputIntake(dependencies, options),
    dependencies,
    completions,
    order
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
