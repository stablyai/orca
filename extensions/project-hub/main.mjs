// Observational plugin: Orca remains the sole owner of worktrees and agents.
export default function activate(orca) {
  orca.commands.register('project-hub-info', async () => ({
    module: 'Project Hub', version: '0.1.0', mode: 'supervised'
  }))
  orca.events.on('worktree.created', () => orca.log('Project Hub observed worktree.created'))
  orca.events.on('worktree.removed', () => orca.log('Project Hub observed worktree.removed'))
  orca.events.on('agent.status.changed', (event) => orca.log('Project Hub agent state: ' + (event?.state ?? 'unknown')))
}
