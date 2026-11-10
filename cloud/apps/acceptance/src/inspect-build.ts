// Debug helper: prints an environment build (as the team owner) without secrets.
//   tsx src/inspect-build.ts <envId> <buildId>
import { control } from './clients'

const [envId, buildId] = process.argv.slice(2)
const owner = { sub: 'w9-owner', org: 'w9-eval-team', orgRole: 'owner' as const }
const envs = await control.as(owner, 'GET', '/v1/environments')
console.log('environments', JSON.stringify(envs.body).slice(0, 1500))
if (envId && buildId) {
  const b = await control.as(owner, 'GET', `/v1/environments/${envId}/builds/${buildId}`)
  console.log('build', JSON.stringify(b.body, null, 1).slice(0, 4000))
}
