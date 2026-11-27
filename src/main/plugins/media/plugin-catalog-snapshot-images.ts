import { createHash } from 'node:crypto'
import type { PluginImageKind } from '../../../shared/plugins/images/plugin-image-fields'
import type { ListedBlob } from '../catalog/plugin-catalog-blob-reader'
import type { CatalogImage } from '../catalog/plugin-catalog-image-extraction'
import {
  snapshotRepositorySlot,
  type CatalogRepositorySlot,
  type PluginMarketplaceCachedSnapshot
} from '../catalog/plugin-marketplace-store'
import type { CheckedPluginImage } from './plugin-image-read'

type DeclaredImage = { kind: PluginImageKind; image: CatalogImage }
type Declarations = { keys: Set<string>; paths: Set<string>; images: DeclaredImage[] }
type Listing = {
  read: Promise<Map<string, ListedBlob> | null>
  value?: Map<string, ListedBlob>
}

/** Identifies one declared use of an image; serving needs every field to match. */
export function catalogImageKey(
  kind: PluginImageKind,
  image: Pick<CatalogImage, 'path' | 'sha256' | 'width' | 'height'>
): string {
  return JSON.stringify([image.path, image.sha256, kind, image.width, image.height])
}

/** Git's id for a blob holding these bytes, so cached bytes can be matched to a listed tree
 *  entry without reading the blob again. */
function gitBlobId(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

/** Keys a source proved at one commit and slot; `writing` holds bytes until their cache write ends. */
export type VerifiedImages = {
  commit: string
  slot: CatalogRepositorySlot
  keys: Set<string>
  writing: Map<string, CheckedPluginImage>
}

/** The source's proofs at the snapshot's commit and slot, started afresh when either changed. */
export function verifiedImagesAt<Source extends object>(
  verified: WeakMap<Source, VerifiedImages>,
  source: Source,
  snapshot: PluginMarketplaceCachedSnapshot
): VerifiedImages {
  const commit = snapshot.marketplaceCommit
  const slot = snapshotRepositorySlot(snapshot)
  let proven = verified.get(source)
  if (proven?.commit !== commit || proven.slot !== slot) {
    proven = { commit, slot, keys: new Set(), writing: new Map() }
    verified.set(source, proven)
  }
  return proven
}

/** What each published snapshot declares, and one shared listing of its image paths. */
export class CatalogSnapshotImages {
  private readonly declarations = new WeakMap<PluginMarketplaceCachedSnapshot, Declarations>()
  private readonly listings = new WeakMap<PluginMarketplaceCachedSnapshot, Listing>()

  constructor(
    private readonly list: (
      snapshot: PluginMarketplaceCachedSnapshot,
      paths: ReadonlySet<string>
    ) => Promise<Map<string, ListedBlob> | null>
  ) {}

  declares(snapshot: PluginMarketplaceCachedSnapshot, key: string): boolean {
    return this.declared(snapshot).keys.has(key)
  }

  /** Each declared use once, icons and covers before screenshots, which only detail pages show. */
  images(snapshot: PluginMarketplaceCachedSnapshot): readonly DeclaredImage[] {
    return this.declared(snapshot).images
  }

  /** The finished listing, if any; a batch read uses it to skip its own listing. */
  listed(snapshot: PluginMarketplaceCachedSnapshot): Map<string, ListedBlob> | undefined {
    return this.listings.get(snapshot)?.value
  }

  /** The cached asset when the snapshot's commit lists its bytes at `path`, by Git blob id. */
  async provenCached<T extends { bytes: Uint8Array }>(
    snapshot: PluginMarketplaceCachedSnapshot,
    path: string,
    cached: Promise<T | null>
  ): Promise<T | null> {
    const [asset, listed] = await Promise.all([cached, this.listing(snapshot)])
    const entry = listed?.get(path)
    return asset && entry && entry.object === gitBlobId(asset.bytes) ? asset : null
  }

  /** Shared by every request against the snapshot; a failed listing is forgotten so a later
   *  request lists again. */
  listing(snapshot: PluginMarketplaceCachedSnapshot): Promise<Map<string, ListedBlob> | null> {
    const known = this.listings.get(snapshot)
    if (known) {
      return known.read
    }
    const forget = (): null => {
      if (this.listings.get(snapshot) === listing) {
        this.listings.delete(snapshot)
      }
      return null
    }
    const listing: Listing = {
      read: this.list(snapshot, this.declared(snapshot).paths).then(
        (listed) => (listed ? (listing.value = listed) : forget()),
        forget
      )
    }
    this.listings.set(snapshot, listing)
    return listing.read
  }

  private declared(snapshot: PluginMarketplaceCachedSnapshot): Declarations {
    const known = this.declarations.get(snapshot)
    if (known) {
      return known
    }
    const declarations: Declarations = { keys: new Set(), paths: new Set(), images: [] }
    const screenshots: DeclaredImage[] = []
    const add = (kind: PluginImageKind, image: CatalogImage | undefined): void => {
      const key = image && catalogImageKey(kind, image)
      if (image && key && !declarations.keys.has(key)) {
        declarations.keys.add(key)
        declarations.paths.add(image.path)
        ;(kind === 'screenshot' ? screenshots : declarations.images).push({ kind, image })
      }
    }
    for (const entry of snapshot.marketplace.plugins) {
      if (!('releases' in entry)) {
        continue
      }
      for (const release of entry.releases ?? []) {
        add('icon', release.images?.icon)
        add('cover', release.images?.cover)
        for (const shot of release.images?.screenshots ?? []) {
          add('screenshot', shot)
        }
      }
    }
    declarations.images.push(...screenshots)
    this.declarations.set(snapshot, declarations)
    return declarations
  }
}
