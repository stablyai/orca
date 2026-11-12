// Cancel handles for builds the window shows on a build sheet, by provision (creation) id.
// `ephemeralVm:cancelProvision` aborts whichever build registered the id: an owned VM or Orca Cloud
// create, or a GitHub-only Orca Cloud create (GH-CREATE-SHEET).
export const activeProvisionControllers = new Map<string, AbortController>()
