import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows heavy-suite Job Object runner', () => {
  it('assigns a suspended child before resume and kills the job tree on handle close', () => {
    const source = readFileSync(new URL('./windows-heavy-suite-job.ps1', import.meta.url), 'utf8')

    expect(source).toContain('CREATE_SUSPENDED')
    expect(source).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(source).toContain('STARTF_USESTDHANDLES')
    expect(source).toContain('GetStdHandle')
    expect(source).toContain('DuplicateHandle')
    expect(source).toContain('NotSupportedException')
    expect(source).not.toContain('cmd.exe')
    expect(source).toContain('STARTUPINFOEX')
    expect(source).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST')
    expect(source).toContain('UpdateProcThreadAttribute')
    expect(source).not.toContain('AssignProcessToJobObject')
    expect(source).toContain('ResumeThread')
    expect(source.lastIndexOf('UpdateProcThreadAttribute(')).toBeLessThan(
      source.lastIndexOf('CreateProcessW(')
    )
    expect(source).toContain('QueryInformationJobObject')
    expect(source).toContain('accounting.ActiveProcesses == 0')
    expect(source.indexOf('QueryInformationJobObject')).toBeLessThan(
      source.lastIndexOf('CloseHandle(job)')
    )
  })
})
