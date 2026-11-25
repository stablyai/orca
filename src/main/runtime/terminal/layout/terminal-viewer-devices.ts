/** Which PTYs each connected client device has viewed, so its departure can stand in for the blur it never sent. */
export class TerminalViewerDevices {
  private readonly ptyIdsByDevice = new Map<string, Set<string>>()

  record(deviceClientId: string, ptyId: string): void {
    const ptyIds = this.ptyIdsByDevice.get(deviceClientId) ?? new Set<string>()
    ptyIds.add(ptyId)
    this.ptyIdsByDevice.set(deviceClientId, ptyIds)
  }

  takeDeparted(deviceClientId: string): string[] {
    const ptyIds = this.ptyIdsByDevice.get(deviceClientId)
    this.ptyIdsByDevice.delete(deviceClientId)
    return ptyIds ? [...ptyIds] : []
  }
}
