-- The VM's Ed25519 signature over each read snapshot ({publicKeyB64, signatureB64} JSON), relayed
-- as-is so devices can check who wrote it. Null for snapshots from VMs before signing.
ALTER TABLE read_snapshots ADD COLUMN signature TEXT;
