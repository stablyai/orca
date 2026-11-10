-- When someone last put the sandbox to sleep on purpose (any desktop window, the CLI, the phone),
-- as opposed to the idle timer. Desktops read it through status so predictive wake leaves a
-- just-slept workspace alone no matter where the sleep came from. Additive.
ALTER TABLE sandboxes ADD COLUMN user_slept_at INTEGER;
