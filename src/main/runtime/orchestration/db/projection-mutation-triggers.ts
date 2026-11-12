export type ProjectionMutationTrigger = {
  table: string
  columns?: string
  mark: (row: 'NEW' | 'OLD') => string
}

/** Connection-local invalidations share the writer's transaction, including rollback. */
export function projectionMutationTriggers(
  name: string,
  triggers: readonly ProjectionMutationTrigger[],
  changed = ''
): string {
  return triggers
    .flatMap((trigger) =>
      [
        { name: 'insert', event: 'AFTER INSERT', rows: ['NEW'] as const },
        { name: 'delete', event: 'AFTER DELETE', rows: ['OLD'] as const },
        {
          name: 'update',
          event: trigger.columns ? `AFTER UPDATE OF ${trigger.columns}` : 'AFTER UPDATE',
          rows: ['OLD', 'NEW'] as const
        }
      ].map(
        (event) => `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_${trigger.table}_${event.name}
${event.event} ON main.${trigger.table}
BEGIN ${changed} ${event.rows.map(trigger.mark).join(' ')} END;`
      )
    )
    .join('\n')
}
