# Left-navigation panel example

This plugin adds **MRs** beside Orca's built-in page navigation and opens a main-content page when clicked. The label demonstrates a dashboard use case; this example does not implement a merge-request provider.

## Run it

1. Use a build containing the left-navigation panel change. Released Orca 1.4.245 does not support it. The manifest declares `>=1.4.246`; maintainers should align that floor with the release containing this API.
2. In Orca's plugin settings, enable the plugin system and add this directory as a development plugin. Review and approve the plugin. It requests no capabilities and has no worker.
3. Click **MRs** in the left navigation. It opens in the main content area and is absent from the right-sidebar activity bar. Click **Check interaction** to verify the frame is interactive.
4. Switch to another page or workspace, then return to **MRs**. Disable the plugin while its page is selected and verify the contributed entry and iframe disappear.
5. Change the panel's `placement` to `right-sidebar`, or remove the field, and reload/reapprove as requested. The same HTML should open from the existing auxiliary right sidebar instead.

## API

```json
{
  "contributes": {
    "panels": [
      {
        "id": "reviews",
        "title": "MRs",
        "icon": "code",
        "placement": "left-navigation",
        "entry": "panel.html"
      }
    ]
  }
}
```

`placement` accepts `left-navigation` and `right-sidebar`. Omitting it retains the right-sidebar default. IDs are namespaced by the plugin identity, so two plugins may use the same panel title without sharing a page. The host controls navigation, icons, selection and mounting; the plugin supplies its HTML through the existing panel loader.

This is an app-level page. A plugin must handle the absence of a focused workspace; folder and remote workspaces retain the same existing workspace-context contract. Older host-list payloads omit placement and retain right-sidebar behavior. Older Orca releases reject the new manifest field, so keep the minimum engine version accurate.

## Security and scope

Changing placement adds no authority. This page uses the same opaque `allow-scripts` iframe, host CSP, theme bridge, consent/content checks and watchdog as right-sidebar panels. It cannot read Orca's DOM or preload API. No network, filesystem, storage or worker API is added by this example. Re-consent, disable and uninstall must revoke the mounted content through the existing plugin lifecycle.

Panel-to-worker invocation, provider authentication, the reserved `sidebarCards` contribution and native mobile navigation are separate APIs and are not introduced here. See the generated [panel reference](../../../docs/reference/plugin-manifest.md#panelcontribution) for the complete manifest fields.
