export function filterUserWslDistros(distros: string[]): string[] {
  return distros.filter((distro) => !distro.toLowerCase().startsWith('docker-desktop'))
}

export function parseWslDistros(output: string): string[] {
  return output
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean)
}
