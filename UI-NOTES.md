# Plane provider UI notes

## Source visibility

Plane follows Jira and remains visible in the Tasks source switcher while disconnected. The Tasks surface is where users already choose a source, so keeping Plane there provides a direct onboarding path and avoids making discovery depend on visiting Settings first. Plane's short token-and-slug flow fits that model well.

## Component structure

- `PlaneConnectDialog` owns Cloud/self-hosted selection and credential entry.
- `PlaneIntegrationCard` owns connection status, testing, disconnecting, and workspace summaries in Settings.
- `PlaneSetupSteps` plugs Plane into the existing task-source setup card scaffolding.
- `TaskPagePlaneSurface` owns status, project selection, and work-item loading; `TaskPagePlaneWorkItemList` owns rows and actions.
- `usePlaneConnection` keeps runtime-aware status loading consistent across the surfaces without adding provider state to the global store.

## Brand icon

The repository did not contain an authoritative Plane mark. `PlaneIcon` therefore uses Lucide's neutral `SquareKanban` icon instead of fabricating a brand logo. A human can replace its implementation when an approved Plane SVG is available without changing call sites.

## Visual checks

Check the connect dialog in Cloud and self-hosted modes, including long connection errors and keyboard focus. In both light and dark mode, verify the integration card's expanded rows, empty/loading/error states, project selector, row hover/focus treatment, truncation at narrow widths, and action-icon contrast. Also test with an SSH/remote runtime, including the unsupported-host error copy and credential-storage notice.

Rendered Electron validation was not available in this session because the required `$electron` skill was not installed; static checks and colocated tests were used instead.
