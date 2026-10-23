import { gitExecFileAsync, gitExecFileSync } from './runner'

type GitRepoCommand = { args: string[]; cwd: string }
export type GitRepoCommands<T> = Generator<GitRepoCommand, T, string>

export function* gitRepoOutput(args: string[], options: { cwd: string }): GitRepoCommands<string> {
  return yield { args, cwd: options.cwd }
}

// One decision tree keeps Git failures and marker fallbacks identical across both callers.
export async function runGitRepoCommands<T>(commands: GitRepoCommands<T>): Promise<T> {
  let step = commands.next()
  while (!step.done) {
    const command = step.value
    try {
      const { stdout } = await gitExecFileAsync(command.args, {
        cwd: command.cwd,
        timeout: 15_000
      })
      step = commands.next(stdout)
    } catch (error) {
      step = commands.throw(error)
    }
  }
  return step.value
}

export function runGitRepoCommandsSync<T>(commands: GitRepoCommands<T>): T {
  let step = commands.next()
  while (!step.done) {
    const command = step.value
    try {
      step = commands.next(gitExecFileSync(command.args, { cwd: command.cwd }))
    } catch (error) {
      step = commands.throw(error)
    }
  }
  return step.value
}
