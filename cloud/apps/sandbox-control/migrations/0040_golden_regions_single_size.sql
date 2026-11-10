-- U17: a snapshot only boots in the region it was taken in, so golden images and environment builds
-- record their region. Every existing row was built in iad1 (the only region used so far). Additive.
ALTER TABLE golden_images ADD COLUMN region TEXT NOT NULL DEFAULT 'iad1';
CREATE INDEX golden_images_region_status ON golden_images (region, status, activated_at);
ALTER TABLE environment_builds ADD COLUMN region TEXT NOT NULL DEFAULT 'iad1';

-- U18: one machine size, Standard = 8 vCPU / 16 GB (the most Vercel Pro allows), which is what Large
-- was. Old desktops may still send `large`; the control plane maps it to standard. usage_outbox keeps
-- what it recorded (billing counts a legacy `large` segment like standard).
UPDATE sandboxes SET machine_size = 'standard' WHERE machine_size = 'large';
UPDATE sandbox_pool SET machine_size = 'standard' WHERE machine_size = 'large';
UPDATE environments SET machine_size = 'standard' WHERE machine_size = 'large';
UPDATE environment_builds SET config = json_set(config, '$.machineSize', 'standard')
  WHERE json_valid(config) AND json_extract(config, '$.machineSize') = 'large';
UPDATE projects SET machine_size = 'standard' WHERE machine_size = 'large';
UPDATE routines SET machine_size = 'standard' WHERE machine_size = 'large';
