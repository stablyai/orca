# Wurkit for Orca

Browse open Wurkit tickets by project and send a ticket to an agent terminal with one click.

## Install for local development

1. In Orca, open **Settings → Plugins** and enable the plugin system.
2. Add the absolute path to this `wurkit` directory under **Development plugin paths**.
3. Enable **Wurkit** and approve the requested capabilities.
4. Open the **Wurkit** panel, paste a Wurkit API key, and choose **Save key securely**. Orca stores the key in the plugin's encrypted secrets vault.
5. Choose a project and an agent terminal. Clicking a ticket sends `Wurk <TICKET> in Wurkit.` to that terminal.

The key needs read access to projects and packages (`projects.read` and `packages.read`). The plugin uses the Wurkit REST API at `https://wurkit-production.up.railway.app/api/rest`; it does not poll in the background. Use **Refresh tickets** to fetch updates. Ticket descriptions are not loaded into the panel.

The Wurkit API request runs in Orca's plugin worker. Orca's sandboxed panel blocks direct network requests, so it asks the worker through the consented `worker:invoke` capability. The panel receives only the project list and compact ticket fields it displays. The API key is submitted once to the worker, saved through Orca's encrypted `secrets` capability, and never written to plugin settings or logs.
