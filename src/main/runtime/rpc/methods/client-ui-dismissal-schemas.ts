import { z } from 'zod'

// Why: one-shot dismissals the renderer writes through ui.set; each was a
// whole-payload rejection for paired clients while unlisted.
export const OneShotDismissalFields = {
  setupGuideSidebarDismissed: z.boolean().optional(),
  setupGuideBrowserMilestoneMigrated: z.boolean().optional(),
  setupGuideBrowserMilestoneLegacyComplete: z.boolean().optional(),
  browserImportHintHidden: z.boolean().optional(),
  mobileEmulatorTabIntroDismissed: z.boolean().optional(),
  combinedDiffFileTreeHintDismissed: z.boolean().optional(),
  mobileEmulatorAgentSetupDismissed: z.boolean().optional(),
  projectOrderManualDefaultNoticeDismissed: z.boolean().optional(),
  usagePercentageDisplayChangeNoticeDismissed: z.boolean().optional(),
  usageEmptyStateDismissed: z.boolean().optional()
}
