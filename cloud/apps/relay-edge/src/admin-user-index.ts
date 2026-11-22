// The erasure index's signed admin ops (admin.ts lists them), after the Worker verified the token
// for the op. Each runs in the user's UserHosts object, which enforces the token's jti.
import { IndexHostBodySchema, UserBodySchema, type UserIndexAdminOp, type VerifiedAdmin } from './admin'
import type { Env } from './env'

const refusedStatus = (outcome: string) => (outcome === 'replay' || outcome === 'jti_full' ? 409 : 200)

export async function handleUserIndexAdmin(env: Env, op: UserIndexAdminOp, verified: VerifiedAdmin): Promise<Response> {
  // A deploy without the binding has no index: as if the route did not exist.
  const namespace = env.USER_HOSTS
  if (!namespace) { return new Response(null, { status: 404 }) }
  const { replay } = verified
  if (op === 'index-host') {
    const body = IndexHostBodySchema.safeParse(verified.body)
    if (!body.success) { return new Response(null, { status: 400 }) }
    const result = await namespace.get(namespace.idFromName(body.data.userId)).adminIndex(body.data.relayHostId, replay)
    return Response.json(result, { status: refusedStatus(result.outcome) })
  }
  const body = UserBodySchema.safeParse(verified.body)
  if (!body.success) { return new Response(null, { status: 400 }) }
  const index = namespace.get(namespace.idFromName(body.data.userId))
  if (op === 'list-hosts') {
    const result = await index.adminList(replay)
    if (result.outcome !== 'listed') { return Response.json(result, { status: 409 }) }
    return Response.json({ relayHostIds: result.relayHostIds })
  }
  const result = await index.adminErase(replay)
  return Response.json(result, { status: refusedStatus(result.outcome) })
}
