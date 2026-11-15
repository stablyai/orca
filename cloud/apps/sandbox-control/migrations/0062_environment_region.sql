-- Nearest region: an environment records the region it lives in (the served region nearest whoever
-- created it), so its builds and the workspaces booted from it stay there (a snapshot only boots in
-- its own region). NULL: made before this was recorded, lives in the default region. Additive.
ALTER TABLE environments ADD COLUMN region TEXT;
