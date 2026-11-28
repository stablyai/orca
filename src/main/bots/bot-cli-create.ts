// `orca serve --allow-cli-bot-create`: a headless host whose operator lets this machine's own `orca`
// CLI create bots outright (`orca bot create` without --offer), so a host can be provisioned from a
// checkout with nobody pressing Create bot. Off unless serve was started with the flag; a desktop
// Orca never turns it on.
let allowed = false

export function setCliBotCreateAllowed(value: boolean): void {
  allowed = value
}

export function isCliBotCreateAllowed(): boolean {
  return allowed
}
