# Shell-Script-Literal Test Framework

Framework for writing shell-ready tests as literal shell scripts that can be copy-pasted into a terminal to replicate.

## Usage

```typescript
import { shellScriptTest } from '../__tests__/shell-ready-framework/shell-script-test'

it('discovers ZDOTDIR from multi-file config', async () => {
  const { stdout } = await shellScriptTest(`
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
  `)

  expect(stdout).toMatchInlineSnapshot(`
    "HOME=<HOME>
    ZDOTDIR=<HOME>/.config/zsh
    "
  `)
})
```

## How it works

1. **Creates temp directories** for `$HOME` and Orca's `userDataPath`

2. **Splits the script** on the `# Run:` marker:
   - Lines before the marker → setup commands
   - Lines after the marker → run command to test

3. **Gets Orca's wrapper config** by calling `getShellReadyLaunchConfig()`

4. **Executes setup** (if present) with bash in temp HOME, using wrapper env

5. **Executes run command** with the wrapper's shell + args + env

6. **Normalizes output** by replacing temp paths with placeholders:
   - Temp HOME → `<HOME>`
   - Wrapper dir → `<WRAPPER_DIR>`
   - Actual user HOME → `<USER_HOME>`

7. **Cleans up** temp directories

8. **Returns** stdout/stderr/exitCode ready for snapshot testing

## Supported shell syntax

**All shell syntax is supported** because the script is executed directly by bash/zsh, not parsed:

- Heredocs (any delimiter, quoted or unquoted)
- Pipes, redirects, command substitution
- Conditionals (`if`, `[[ ]]`, `&&`, `||`)
- Loops, functions, variables
- Any valid shell script

## Manual replication

To manually replicate a test scenario, copy the shell commands from the test:

```bash
# Setup commands (before # Run: marker):
mkdir -p ~/.config/zsh
cat > ~/.config/zsh/env <<'EOF'
export ZDOTDIR="$HOME/.config/zsh"
EOF

cat > ~/.zshenv <<'EOF'
source "$HOME/.config/zsh/env"
EOF

# Run command (after # Run: marker):
zsh -c 'env | grep -E "^(ORCA_|ZDOTDIR|HOME)=" | sort'
```

**Note**: The test framework applies Orca's wrapper configuration (sets `ZDOTDIR` to wrapper directory, etc.). When running manually, you'll see different output unless you also configure the wrapper environment.

## Snapshot testing

Use `toMatchInlineSnapshot()` to keep expected output visible in the test file:

```typescript
expect(stdout).toMatchInlineSnapshot(`
  "HOME=<HOME>
  ZDOTDIR=<HOME>/.config/zsh
  "
`)
```

Update snapshots with `vitest -u`.

## When to use this framework

Use this framework for **new shell-ready tests** where:

- You want the test to be easy to replicate manually
- The setup is shell-script-based (file creation, env vars)
- You want a declarative snapshot-driven style

**Don't migrate existing tests** - this framework is opt-in for new tests only.
