// Features owned by workstreams that have not landed in the deployed dev stack yet. Each probe looks
// for the surface the feature needs; it flips to a real check when the workstream merges.
import { control } from '../clients'
import type { Check, Outcome } from '../context'

const waiting = (owner: string, what: string): Outcome => ({ status: 'not_landed', detail: `${what} — waiting on ${owner}` })

async function routeExists(path: string, method = 'GET'): Promise<number> {
  const r = await control.as({ sub: 'w9-eval' }, method, path)
  return r.status
}

export const pendingChecks: Record<string, Check> = {
  'cli.web': async () => ({
    status: 'deferred',
    detail: 'Post-MVP (coordinator decision 2026-11-10): design only; needs browser sign-in on the Orca Cloud auth service before a web client can pair. Not counted as a failure.'
  }),
  'env.build': async () => {
    const status = await routeExists('/v1/environments')
    return status === 404 ? waiting('w1-env-builds', 'no /v1/environments route on the dev control plane') : { status: 'partial', detail: `GET /v1/environments -> ${status}; check not written yet` }
  },
  'api.rest': async () => {
    const status = await routeExists('/v1/workspaces')
    return status === 404 ? waiting('w5-api-routines', 'no /v1/workspaces (API key) route') : { status: 'partial', detail: `GET /v1/workspaces -> ${status}; check not written yet` }
  }
}
