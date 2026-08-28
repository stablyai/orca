import path from 'node:path'

import { runProcess } from '../../shared/child-process/run-process'

function ninjaWorkspace(): string {
  const configured = process.env.ORCA_NINJAONE_TOOLS_DIR?.trim()
  if (configured) {
    return configured
  }
  if (process.platform === 'win32') {
    return 'C:\\Users\\ee01287\\Documents\\Projects\\NinjaOne'
  }
  throw new Error('Set ORCA_NINJAONE_TOOLS_DIR to enable NinjaOne writes')
}

export async function updateNinjaCliTicket(args: {
  id: string
  title?: string
  status?: string
  assignee?: string | null
  comment?: string
  priority?: string
  severity?: string
}): Promise<void> {
  const workspace = ninjaWorkspace()
  const python =
    process.platform === 'win32'
      ? path.join(workspace, 'mcp', '.venv', 'Scripts', 'python.exe')
      : path.join(workspace, 'mcp', '.venv', 'bin', 'python')
  const command = [
    '-m',
    'ninjaone_mcp.cli',
    '--env',
    path.join(workspace, '.env'),
    'set',
    args.id
  ]
  if (args.title !== undefined) {
    command.push('--subject', args.title)
  }
  if (args.status !== undefined) {
    command.push('--status', args.status.trim().toUpperCase().replaceAll(' ', '_'))
  }
  if (args.assignee) {
    command.push('--assignee', args.assignee)
  }
  if (args.priority !== undefined) {
    command.push('--priority', args.priority)
  }
  if (args.severity !== undefined) {
    command.push('--severity', args.severity)
  }
  if (command.length > 6) {
    const result = await runProcess({
      program: python,
      args: command,
      cwd: path.join(workspace, 'mcp'),
      timeoutMs: 20_000
    })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'NinjaOne ticket update failed')
    }
  }
  if (args.comment?.trim()) {
    const result = await runProcess({
      program: python,
      args: [
        '-m',
        'ninjaone_mcp.cli',
        '--env',
        path.join(workspace, '.env'),
        'comment',
        args.id,
        args.comment.trim()
      ],
      cwd: path.join(workspace, 'mcp'),
      timeoutMs: 20_000
    })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'NinjaOne comment failed')
    }
  }
}
