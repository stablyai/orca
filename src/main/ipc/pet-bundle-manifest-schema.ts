import { z } from 'zod'
import type { PetManifestLike } from './pet-bundle'

export const PetManifestSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    displayName: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    spritesheetPath: z
      .string()
      .min(1)
      .max(255)
      // Why: belt-and-suspenders vs malicious manifests — downstream resolve+prefix check still runs as defense in depth.
      .refine(
        (p) => !p.includes('\0') && !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..'),
        'invalid spritesheetPath'
      )
      .optional(),
    frame: z
      .object({
        width: z.number().int().positive().max(1024),
        height: z.number().int().positive().max(1024)
      })
      .optional(),
    fps: z.number().positive().max(60).optional(),
    defaultAnimation: z.string().min(1).max(64).optional(),
    animations: z
      .record(
        z.string().min(1).max(64),
        z.object({
          row: z.number().int().min(0).max(256),
          frames: z.number().int().positive().max(512),
          // Why: cap each hold at 60s so a bad manifest can't freeze the overlay.
          frameDurationsMs: z.array(z.number().positive().max(60_000)).max(512).optional()
        })
      )
      .optional()
  })
  // Why: .loose() ignores unknown manifest fields — generators emit metadata we don't consume; strict would reject imports.
  .loose()

export type PetManifest = z.infer<typeof PetManifestSchema> & PetManifestLike
