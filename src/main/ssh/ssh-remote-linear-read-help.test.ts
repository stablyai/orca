import { describe, expect, it } from 'vitest'
import { getRemoteLinearReadHelp } from './ssh-remote-linear-read-help'

describe('SSH Linear read help', () => {
  it('lists the project read commands in the linear group help', () => {
    const help = getRemoteLinearReadHelp(['linear'])

    expect(help).toContain('Usage: orca linear <command> [options]')
    expect(help).toContain('project show')
    expect(help).toContain('project statuses')
    expect(help).toContain('project labels')
    expect(help).toContain('project list')
  })

  it('prints project group help for the bare project path', () => {
    const help = getRemoteLinearReadHelp(['linear', 'project'])

    expect(help).toContain('Usage: orca linear project <command> [options]')
    expect(help).toContain('show')
    expect(help).toContain('statuses')
    expect(help).toContain('labels')
    expect(help).toContain('update')
  })

  it('prints project update group help without claiming a read command', () => {
    const help = getRemoteLinearReadHelp(['linear', 'project', 'update'])

    expect(help).toContain('Usage: orca linear project update <command> [options]')
    expect(help).toContain('add')
  })

  it('prints project show leaf help with its target and update flags', () => {
    const help = getRemoteLinearReadHelp(['linear', 'project', 'show'])

    expect(help).toContain('Usage: orca linear project show (<project> | --id <project>)')
    expect(help).toContain('--updates')
    expect(help).toContain('--updates-limit <n>')
    expect(help).toContain('--workspace <id>')
  })

  it('prints project statuses and labels leaf help', () => {
    const statuses = getRemoteLinearReadHelp(['linear', 'project', 'statuses'])
    const labels = getRemoteLinearReadHelp(['linear', 'project', 'labels'])

    expect(statuses).toContain('Usage: orca linear project statuses [--query <text>]')
    expect(statuses).toContain('[--workspace <id>|all]')
    expect(labels).toContain('Usage: orca linear project labels [--query <text>]')
    expect(labels).toContain('[--workspace <id>|all]')
  })

  it('keeps existing leaf help and unknown paths unchanged', () => {
    expect(getRemoteLinearReadHelp(['linear', 'project', 'list'])).toContain(
      'Usage: orca linear project list'
    )
    expect(getRemoteLinearReadHelp(['linear', 'issue'])).toContain('Usage: orca linear issue')
    expect(getRemoteLinearReadHelp(['linear', 'project', 'create'])).toBeNull()
    expect(getRemoteLinearReadHelp(['linear', 'project', 'update', 'add'])).toBeNull()
  })
})
