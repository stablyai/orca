DROP TABLE IF EXISTS tenant.user_workspace_sessions;

ALTER TABLE tenant.user_profiles
  DROP COLUMN IF EXISTS keybindings_json,
  DROP COLUMN IF EXISTS ui_local_state_json,
  DROP COLUMN IF EXISTS saved_runtime_environments_json,
  DROP COLUMN IF EXISTS client_settings_json,
  DROP COLUMN IF EXISTS accounts_dev_server_json;
