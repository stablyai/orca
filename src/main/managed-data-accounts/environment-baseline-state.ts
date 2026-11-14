import { randomUUID } from 'node:crypto'
import {
  captureManagedDataAccountOriginalEnvironment,
  restoreManagedDataAccountEnvironment
} from '../../shared/managed-data-account-environment'

const MAX_INLINE_AUTH_BASELINES = 64
const MAX_INLINE_AUTH_BYTES = 64 * 1024

type InlineAuthBaseline = { value: string; selections: Set<string> }

/** Keeps inline OpenCode auth references owned by one managed-account service. */
export class ManagedDataAccountEnvironmentBaselineState {
  private readonly inlineAuthBaselines = new Map<string, InlineAuthBaseline>()

  captureOriginalEnvironment(
    environment: Record<string, string>,
    selected: Record<string, string>
  ): void {
    const value = environment.OPENCODE_AUTH_CONTENT
    let reference: string | undefined
    if (value && selected.OPENCODE_AUTH_CONTENT === '') {
      if (Buffer.byteLength(value, 'utf8') > MAX_INLINE_AUTH_BYTES) {
        throw new Error('Inline authentication exceeds the managed launch limit.')
      }
      const selection = JSON.stringify([selected.XDG_DATA_HOME, selected.XDG_STATE_HOME])
      const existing = [...this.inlineAuthBaselines].find(([, entry]) => entry.value === value)
      if (existing) {
        const [id, entry] = existing
        if (
          !entry.selections.has(selection) &&
          entry.selections.size >= MAX_INLINE_AUTH_BASELINES
        ) {
          throw new Error('Managed inline authentication context limit reached.')
        }
        entry.selections.add(selection)
        reference = id
      } else {
        if (this.inlineAuthBaselines.size >= MAX_INLINE_AUTH_BASELINES) {
          throw new Error('Managed inline authentication baseline limit reached.')
        }
        reference = randomUUID()
        this.inlineAuthBaselines.set(reference, { value, selections: new Set([selection]) })
      }
    }
    captureManagedDataAccountOriginalEnvironment(environment, reference)
  }

  restoreOriginalEnvironment(environment: Record<string, string | undefined>): void {
    // Restoring copied references requires the original overlay captured by this service.
    const selection = JSON.stringify([
      environment.ORCA_DATA_ACCOUNT_DATA_HOME,
      environment.ORCA_DATA_ACCOUNT_STATE_HOME
    ])
    const ownsSelection =
      environment.ORCA_DATA_ACCOUNT_PROVIDER === 'opencode' &&
      environment.OPENCODE_AUTH_CONTENT === '' &&
      environment.OPENCODE_DB === 'opencode.db' &&
      environment.XDG_DATA_HOME === environment.ORCA_DATA_ACCOUNT_DATA_HOME &&
      environment.XDG_STATE_HOME === environment.ORCA_DATA_ACCOUNT_STATE_HOME
    restoreManagedDataAccountEnvironment(environment, true, (reference) => {
      const baseline = this.inlineAuthBaselines.get(reference)
      return ownsSelection && baseline?.selections.has(selection) ? baseline.value : undefined
    })
  }

  clear(): void {
    this.inlineAuthBaselines.clear()
  }
}
