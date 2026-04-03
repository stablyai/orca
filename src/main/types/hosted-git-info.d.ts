declare module 'hosted-git-info' {
  type HostedGitInfo = {
    browseFile(path: string, opts?: { committish?: string; fragment?: string }): string | undefined
    browse(path?: string, opts?: { committish?: string; fragment?: string }): string | undefined
  }

  type HostedGitInfoStatic = {
    fromUrl(url: string): HostedGitInfo | undefined
  }

  const hostedGitInfo: HostedGitInfoStatic
  export default hostedGitInfo
}
