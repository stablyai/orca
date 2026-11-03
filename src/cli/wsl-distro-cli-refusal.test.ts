import { describe, expect, it } from 'vitest'
import { formatCliError } from './cli-error'
import { RuntimeClientError } from './runtime/types'
import { readableWslDistroCliRefusal } from './wsl-distro-cli-refusal'

describe('readableWslDistroCliRefusal', () => {
  it("names the distro in an older server's raw hold code", () => {
    expect(readableWslDistroCliRefusal('terminal_held_wsl_distro_stopped:Ubuntu')).toBe(
      "The WSL distro Ubuntu is stopped, so Orca didn't start this terminal. Start the distro, then try again."
    )
  })

  it.each(['\\\\wsl.localhost\\Ubuntu\\home\\me\\notes', '\\\\wsl$\\Ubuntu\\home\\me\\notes'])(
    'names the distro behind an unavailable WSL folder (%s)',
    (path) => {
      expect(readableWslDistroCliRefusal(`folder_workspace_path_unavailable:${path}`)).toBe(
        `Orca couldn't reach ${path}. The WSL distro Ubuntu may be stopped, and Orca doesn't start a stopped distro for this. Start Ubuntu (for example, open a terminal in it), then try again.`
      )
    }
  )

  it('leaves other refusals as they were', () => {
    for (const message of ['folder_workspace_path_unavailable:/srv/notes', 'terminal_not_found']) {
      expect(readableWslDistroCliRefusal(message)).toBe(message)
    }
  })

  it('reads in the human CLI error output', () => {
    const error = new RuntimeClientError(
      'runtime_error',
      'folder_workspace_path_unavailable:\\\\wsl.localhost\\Debian\\w'
    )
    expect(formatCliError(error)).toContain('The WSL distro Debian may be stopped')
  })
})
