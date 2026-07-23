export type HerdrCommand = { file: string; args: string[]; env?: NodeJS.ProcessEnv }

export function localHerdrCommand(
  executable = 'herdr',
  env?: NodeJS.ProcessEnv
): (args: string[]) => HerdrCommand {
  return (args) => ({ file: executable, args, ...(env ? { env } : {}) })
}
