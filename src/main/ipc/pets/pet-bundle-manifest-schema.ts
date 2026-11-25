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
      // Reject unsafe manifest paths before the later resolved-path containment check.
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
          // Bound frame holds so malformed manifests cannot freeze the overlay.
          frameDurationsMs: z.array(z.number().positive().max(60_000)).max(512).optional()
        })
      )
      .optional()
  })
  // Accept generator metadata beyond the fields Orca consumes.
  .loose()

export type PetManifest = z.infer<typeof PetManifestSchema> & PetManifestLike
