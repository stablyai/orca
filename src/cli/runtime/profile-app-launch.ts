export function appendProfileUserDataArg(args: string[], userDataPath: string): string[] {
  return [...args, `--user-data-dir=${userDataPath}`]
}

export function buildProfileLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  userDataPath: string
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ORCA_USER_DATA_PATH: userDataPath,
    ORCA_DEV_USER_DATA_PATH: userDataPath
  }
}
