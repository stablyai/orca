export function resumeStoppedWslHookRelays(
  stoppedByHooksOff: Map<string, string | undefined>,
  isDistroRunning: (distro: string) => Promise<boolean>,
  ensureForDistro: (distro: string, codexHomePath?: string) => void
): void {
  const distros = [...stoppedByHooksOff]
  stoppedByHooksOff.clear()
  for (const [distro, codexHomePath] of distros) {
    void isDistroRunning(distro)
      .then((running) => {
        if (running) {
          ensureForDistro(distro, codexHomePath)
        }
      })
      .catch(() => undefined)
  }
}
