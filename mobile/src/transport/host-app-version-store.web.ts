// Only native troubleshooting reads version storage; page writes would be refused bridge noise with no reader.
export const loadHostAppVersion = (_hostId: string): Promise<string | null> => Promise.resolve(null)

export const recordHostAppVersion = (_hostId: string, _value: unknown): Promise<void> =>
  Promise.resolve()
