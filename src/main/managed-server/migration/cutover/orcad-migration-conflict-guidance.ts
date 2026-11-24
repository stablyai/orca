/** Name conflicting server-owned state and recovery steps; retries cannot resolve different copies. */
const CONFLICT =
  /orcad_migration_(repository_path|repository_id|project_group_id|folder_workspace_id|dormant_id|dormant_focus|client_state|close_intent_destination|snapshot_destination)_conflict(?::(.+))?/

const LINKED_PROJECT_TERMINALS = /orcad_migration_linked_project_terminals:(.+)/
const UNOWNED_TERMINALS = /orcad_migration_linked_project_unowned_terminals:(.+)/

export function isBridgedTerminalLinkConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return LINKED_PROJECT_TERMINALS.test(message) || UNOWNED_TERMINALS.test(message)
}

/** Exclude transient staged claims from permanent-conflict guidance. */
export function orcadMigrationConflictGuidance(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const terminals = LINKED_PROJECT_TERMINALS.exec(message)
  if (terminals) {
    return (
      `Terminals an older version of Orca started in ${terminals[1]} are still running, and this ` +
      'host’s Orca server already has that project from another Orca desktop. Close them or ' +
      'end them on the host, then reconnect, or remove that project from this desktop and ' +
      'connect again.'
    )
  }
  const unowned = UNOWNED_TERMINALS.exec(message)
  if (unowned) {
    return (
      'A terminal an older version of Orca started on this host is still running, and Orca can’t ' +
      'tell which project it belongs to. Close it or end it on the host, ' +
      `then reconnect. Or, to use this host’s Orca server’s copy of ${unowned[1]}, remove that ` +
      'project from this desktop and connect again.'
    )
  }
  const match = CONFLICT.exec(message)
  if (!match) {
    return null
  }
  const [code, kind, subject] = match
  switch (kind) {
    case 'repository_path':
      return (
        `This host’s Orca server already has a project at ${subject}, which another Orca desktop ` +
        'added while this one was moving it. Retrying won’t clear it. To use the server’s project, ' +
        `remove that project from this desktop and connect again. (${code})`
      )
    case 'repository_id':
      return (
        'This host’s Orca server already has one of this desktop’s projects with different ' +
        'settings. Retrying won’t clear it. To use the server’s copy, remove that project from this ' +
        `desktop and connect again. (${code})`
      )
    default:
      return (
        'This host’s Orca server already holds different saved state for something this desktop ' +
        'is moving, so nothing was moved and this desktop keeps its projects. Retrying won’t clear ' +
        `it. (${code})`
      )
  }
}
