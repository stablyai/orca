export function getZipExtractorCommand(zipPath, extractDir) {
  if (process.platform === 'win32') {
    return {
      file: process.env.ORCA_POWERSHELL_BIN || 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          "$ErrorActionPreference = 'Stop'",
          `Expand-Archive -LiteralPath ${quotePowerShellLiteral(zipPath)} -DestinationPath ${quotePowerShellLiteral(extractDir)} -Force`
        ].join('; ')
      ],
      label: 'powershell Expand-Archive'
    }
  }
  return {
    file: process.env.ORCA_UNZIP_BIN || 'unzip',
    args: ['-q', zipPath, '-d', extractDir],
    label: 'unzip'
  }
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
