import { SetupRunRegistry } from '../setup/setup-run'
import { OrcaRuntimeWithRuntimeId } from './runtime-identity-state'

export abstract class OrcaRuntimeWithSetupRuns extends OrcaRuntimeWithRuntimeId {
  private readonly setupRuns = new SetupRunRegistry()
  readonly registerSetupRun = this.setupRuns.register
  readonly getSetupRun = this.setupRuns.get
  readonly forgetSetupRun = this.setupRuns.forget
}
