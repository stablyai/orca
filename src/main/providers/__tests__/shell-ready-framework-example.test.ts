/**
 * Example test using the shell-script-literal framework.
 *
 * This demonstrates the pattern for future shell-ready tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'
import { shellScriptTest } from './shell-ready-framework/shell-script-test'

const { getUserDataPathMock } = vi.hoisted(() => ({
  getUserDataPathMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return getUserDataPathMock()
      }
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

const hasZsh = process.platform !== 'win32' && spawnSync('which', ['zsh']).status === 0
const describeIfZsh = hasZsh ? describe : describe.skip

describeIfZsh('shell-script-literal framework example', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'shell-test-userdata-'))
    getUserDataPathMock.mockReturnValue(userDataPath)
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('discovers ZDOTDIR when .zshenv sources another file', async () => {
    const { stdout } = await shellScriptTest(
      `
      # Setup multi-file config
      mkdir -p ~/.config/zsh
      cat > ~/.config/zsh/env <<'EOF'
export ZDOTDIR="$HOME/.config/zsh"
EOF

      cat > ~/.zshenv <<'EOF'
source "$HOME/.config/zsh/env"
EOF

      # Run: check discovered ZDOTDIR
      zsh -c 'env | grep -E "^(ORCA_|ZDOTDIR|HOME)=" | sort'
    `,
      { userDataPath }
    )

    expect(stdout).toMatchInlineSnapshot(`
      "HOME=<HOME>
      ZDOTDIR=<HOME>/.config/zsh
      "
    `)
  })

  it('handles conditional ZDOTDIR based on SSH_CONNECTION', async () => {
    const { stdout } = await shellScriptTest(
      `
      mkdir -p ~/.config/zsh-local ~/.config/zsh-remote
      cat > ~/.zshenv <<'EOF'
if [[ -n "$SSH_CONNECTION" ]]; then
  export ZDOTDIR="$HOME/.config/zsh-remote"
else
  export ZDOTDIR="$HOME/.config/zsh-local"
fi
EOF

      # Run with SSH_CONNECTION set
      SSH_CONNECTION='192.168.1.100 52100 192.168.1.1 22' zsh -c 'env | grep ZDOTDIR | sort'
    `,
      { userDataPath }
    )

    expect(stdout).toMatchInlineSnapshot(`
      "ORCA_ORIG_ZDOTDIR=<HOME>
      ZDOTDIR=<HOME>/.config/zsh-remote
      "
    `)
  })
})
