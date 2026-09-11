import { describe, expect, it } from 'vitest'
import { getWorkspaceDetectAgentsParams } from './workspace-agent-detection-target'

describe('workspace agent detection target', () => {
  it('names the distro of a repo that lives inside WSL', () => {
    expect(
      getWorkspaceDetectAgentsParams('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\project')
    ).toEqual({ wslDistro: 'Ubuntu-24.04' })
    expect(getWorkspaceDetectAgentsParams('\\\\wsl$\\Debian\\home\\dev\\project')).toEqual({
      wslDistro: 'Debian'
    })
  })

  it('leaves the target unset for a repo on the host filesystem', () => {
    expect(getWorkspaceDetectAgentsParams('C:\\dev\\project')).toBeUndefined()
    expect(getWorkspaceDetectAgentsParams('/home/dev/project')).toBeUndefined()
    expect(getWorkspaceDetectAgentsParams(null)).toBeUndefined()
    expect(getWorkspaceDetectAgentsParams(undefined)).toBeUndefined()
  })
})
