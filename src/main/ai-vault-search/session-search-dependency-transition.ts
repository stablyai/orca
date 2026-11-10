import type { SessionSearchCatalog } from './session-search-catalog'

export type SessionSearchDependencyCommand = {
  kind: 'dependency-step'
  scope: string
  phase: 'install' | 'remove'
  after?: string
}

export function transitionSessionSearchDependency(
  catalog: SessionSearchCatalog,
  command: SessionSearchDependencyCommand
): { after?: string } {
  const accepted = `${command.scope}:accepted`
  const staging = `${command.scope}:staging`
  const changed = `${command.scope}:changed`
  const page = catalog.execute({
    kind: 'page',
    scope: command.phase === 'install' ? staging : accepted,
    after: command.after
  })
  for (const row of page.rows ?? []) {
    const peer = catalog.execute({
      kind: 'get',
      scope: command.phase === 'install' ? accepted : staging,
      key: row.key
    }).rows?.[0]
    if (command.phase === 'install') {
      if (peer?.value !== row.value) {
        catalog.execute({ kind: 'put', scope: changed, rows: [{ ...row, value: 'true' }] })
      }
      catalog.execute({ kind: 'put', scope: accepted, rows: [row] })
    } else if (!peer) {
      catalog.execute({ kind: 'put', scope: changed, rows: [{ ...row, value: 'true' }] })
      catalog.execute({ kind: 'delete', scope: accepted, key: row.key })
    }
  }
  return { after: page.after }
}
