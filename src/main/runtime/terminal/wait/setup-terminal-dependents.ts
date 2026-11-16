import { randomUUID } from 'node:crypto'
import type { TerminalSetupVerdict } from '../../../../shared/terminal/pty/lifecycle/terminal-setup-status'

type SetupCompletion = { exitCode: number | null }

export class SetupTerminalDependents {
  private readonly dependents = new Map<
    string,
    {
      workspaceId: string
      completion: Promise<SetupCompletion>
      cancel: () => void
      verdict: TerminalSetupVerdict
    }
  >()
  private readonly dependentIdsByWorkspace = new Map<string, Set<string>>()
  constructor(private readonly changed: (ptyId: string, verdict: TerminalSetupVerdict) => void) {}

  status(ptyId: string): TerminalSetupVerdict {
    return this.dependents.get(ptyId)?.verdict ?? { dependencyId: null, state: 'ready' }
  }

  bindDependent(
    workspaceId: string,
    ptyId: string,
    completion: Promise<SetupCompletion>
  ): () => void {
    const cancelled = Promise.withResolvers<SetupCompletion>()
    const dependent: {
      workspaceId: string
      verdict: TerminalSetupVerdict
      completion: Promise<SetupCompletion>
      cancel: () => void
    } = {
      workspaceId,
      verdict: { dependencyId: randomUUID(), state: 'pending' } satisfies TerminalSetupVerdict,
      completion: Promise.race([completion, cancelled.promise]),
      cancel: () => cancelled.resolve({ exitCode: null })
    }
    this.forgetDependent(ptyId)
    this.dependents.set(ptyId, dependent)
    let ids = this.dependentIdsByWorkspace.get(workspaceId)
    if (!ids) {
      ids = new Set()
      this.dependentIdsByWorkspace.set(workspaceId, ids)
    }
    ids.add(ptyId)
    void dependent.completion.then(({ exitCode }) => {
      if (this.dependents.get(ptyId) !== dependent || dependent.verdict.state !== 'pending') {
        return
      }
      dependent.verdict = {
        dependencyId: dependent.verdict.dependencyId,
        state: exitCode === 0 ? 'ready' : exitCode === null ? 'unknown' : 'failed'
      }
      this.changed(ptyId, dependent.verdict)
    })
    return () => {
      if (this.dependents.get(ptyId) === dependent) {
        this.forgetDependent(ptyId)
      }
    }
  }

  forDependent(ptyId: string): Promise<SetupCompletion> | undefined {
    return this.dependents.get(ptyId)?.completion
  }

  forgetDependent(ptyId: string): void {
    const dependent = this.dependents.get(ptyId)
    if (!dependent) {
      return
    }
    dependent.cancel()
    this.changed(ptyId, { dependencyId: dependent.verdict.dependencyId, state: 'unknown' })
    this.dependents.delete(ptyId)
    const ids = this.dependentIdsByWorkspace.get(dependent.workspaceId)
    ids?.delete(ptyId)
    if (ids?.size === 0) {
      this.dependentIdsByWorkspace.delete(dependent.workspaceId)
    }
  }

  protected endDependent(ptyId: string): void {
    const dependent = this.dependents.get(ptyId)
    if (dependent?.verdict.state !== 'pending') {
      return
    }
    dependent.verdict = { dependencyId: dependent.verdict.dependencyId, state: 'unknown' }
    dependent.cancel()
    this.changed(ptyId, dependent.verdict)
  }

  protected forgetWorkspaceDependents(workspaceId: string): void {
    for (const id of this.dependentIdsByWorkspace.get(workspaceId) ?? []) {
      this.forgetDependent(id)
    }
  }
}
