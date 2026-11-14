// `orca serve --supervise` runs orcad under a service manager, which restarts it routinely.
import process from 'node:process'
import { ORCA_SERVE_SUPERVISED_ENV } from '../../../shared/serve-supervised-terminal-durability'

/** A supervised service must not hand out terminals that its next restart would kill. */
export class OrcadTerminalsNotDurableError extends Error {
  constructor(readonly daemonFailure: string) {
    super(
      `The terminal daemon did not start (${daemonFailure}). This server runs under a service ` +
        'manager, so it will not start with terminals that a restart would lose; the supervisor ' +
        'retries with backoff.'
    )
    this.name = 'OrcadTerminalsNotDurableError'
  }
}

/** Read once and drop it, so nothing orcad starts inherits it. */
export function takeOrcadServeSupervision(env: NodeJS.ProcessEnv = process.env): boolean {
  const supervised = env[ORCA_SERVE_SUPERVISED_ENV] === '1'
  delete env[ORCA_SERVE_SUPERVISED_ENV]
  return supervised
}
