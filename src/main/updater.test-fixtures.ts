export const releaseTagUrl = 'https://github.com/stablyai/orca/releases/tag/v1.0.61'

export const releaseDownloadUrls = {
  darwin: 'https://github.com/stablyai/orca/releases/download/v1.0.61/orca-macos-arm64.dmg',
  linux: 'https://github.com/stablyai/orca/releases/download/v1.0.61/orca-linux.AppImage',
  win32: 'https://github.com/stablyai/orca/releases/download/v1.0.61/orca-windows-setup.exe'
} as const

export function getFallbackAssetUrl(): string {
  if (process.platform === 'darwin') {
    return releaseDownloadUrls.darwin
  }
  if (process.platform === 'win32') {
    return releaseDownloadUrls.win32
  }
  return releaseDownloadUrls.linux
}

export function buildReleaseLookupResponse(): {
  draft: boolean
  prerelease: boolean
  tag_name: string
  html_url: string
  assets: { name: string; browser_download_url: string }[]
}[] {
  return [
    {
      draft: false,
      prerelease: false,
      tag_name: 'v1.0.62',
      html_url: 'https://github.com/stablyai/orca/releases/tag/v1.0.62',
      assets: []
    },
    {
      draft: false,
      prerelease: false,
      tag_name: 'v1.0.61',
      html_url: releaseTagUrl,
      assets: [
        {
          name: 'orca-macos-arm64.dmg',
          browser_download_url: releaseDownloadUrls.darwin
        },
        {
          name: 'orca-windows-setup.exe',
          browser_download_url: releaseDownloadUrls.win32
        },
        {
          name: 'orca-linux.AppImage',
          browser_download_url: releaseDownloadUrls.linux
        }
      ]
    }
  ]
}
