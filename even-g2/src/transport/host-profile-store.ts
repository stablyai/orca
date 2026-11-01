// Persists paired host profiles through GlassesBridge storage (bridge.getLocalStorage /
// setLocalStorage), never browser localStorage — that storage is wiped in the .ehpk WebView
// (see spec S3 "Storage"). Writing '' means "delete"; there is no separate delete call.
import { z } from 'zod'
import type { GlassesBridge } from '../glasses/glasses-bridge'
import type { GlassesHostProfile } from '../state/hud-store'

const STORAGE_KEY = 'orca.hostProfiles.v1'

const GlassesHostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite()
}) satisfies z.ZodType<GlassesHostProfile>

const GlassesHostProfileListSchema = z.array(GlassesHostProfileSchema)

export class HostProfileStore {
  constructor(private readonly bridge: GlassesBridge) {}

  async load(): Promise<GlassesHostProfile[]> {
    const raw = await this.bridge.getStoredValue(STORAGE_KEY)
    if (!raw) {
      return []
    }
    try {
      const parsed = GlassesHostProfileListSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }

  async upsert(profile: GlassesHostProfile): Promise<void> {
    const profiles = await this.load()
    const next = profiles.filter((existing) => existing.id !== profile.id)
    next.push(profile)
    await this.write(next)
  }

  async remove(id: string): Promise<void> {
    const profiles = await this.load()
    const next = profiles.filter((existing) => existing.id !== id)
    await this.write(next)
  }

  private async write(profiles: GlassesHostProfile[]): Promise<void> {
    const value = profiles.length === 0 ? '' : JSON.stringify(profiles)
    await this.bridge.setStoredValue(STORAGE_KEY, value)
  }
}
