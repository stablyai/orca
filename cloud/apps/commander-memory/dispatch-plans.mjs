import { Buffer } from 'node:buffer'

export function openDispatchPlans(db, fail) {
  db.exec(`CREATE TABLE IF NOT EXISTS dispatch_plans (
    tenant TEXT NOT NULL, request TEXT NOT NULL, actor TEXT NOT NULL, project TEXT NOT NULL,
    plan TEXT NOT NULL, PRIMARY KEY(tenant, request))`)
  const insert = db.prepare('INSERT INTO dispatch_plans VALUES (?, ?, ?, ?, ?)')
  const get = db.prepare(
    'SELECT plan FROM dispatch_plans WHERE tenant=? AND request=? AND actor=? AND project=?'
  )
  return {
    validate(identity, edit, plan) {
      if (
        identity.actor.type !== 'commander' ||
        edit.projectId !== identity.projectId ||
        edit.kind !== 'decision' ||
        edit.expectedVersion !== 0 ||
        edit.pageId !== `dispatch-${edit.requestId}` ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(edit.requestId)
      ) {
        fail(403, 'Invalid scope for a frozen dispatch plan')
      }
      if (
        !plan ||
        typeof plan !== 'object' ||
        Array.isArray(plan) ||
        typeof plan.binding !== 'string' ||
        !/^[a-f0-9]{64}$/.test(plan.binding) ||
        typeof plan.guidelines !== 'string' ||
        Buffer.byteLength(plan.guidelines) > 8192 ||
        typeof plan.reason !== 'string' ||
        !plan.reason.length ||
        plan.reason.length > 4096 ||
        [plan.model, plan.effort].some(
          (value) =>
            value !== undefined &&
            (typeof value !== 'string' || !value.length || value.length > 512)
        )
      ) {
        fail(400, 'Invalid frozen dispatch plan')
      }
      return {
        binding: plan.binding,
        model: plan.model,
        effort: plan.effort,
        reason: plan.reason,
        guidelines: plan.guidelines
      }
    },
    insert({ tenant, actor, projectId }, requestId, plan) {
      insert.run(tenant, requestId, actor.id, projectId, JSON.stringify(plan))
    },
    read({ tenant, actor, projectId }, requestId) {
      if (actor.type !== 'commander') fail(403, 'A delegated Commander credential is required')
      const row = get.get(tenant, requestId, actor.id, projectId)
      if (!row) fail(404, 'No frozen plan for this Commander request')
      return { projectId, pageId: `dispatch-${requestId}`, plan: JSON.parse(row.plan) }
    }
  }
}
