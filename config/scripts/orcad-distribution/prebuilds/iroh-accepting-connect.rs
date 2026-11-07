    /// Let runtimes reject stock natives before binding, even after signing or loader fixups.
    #[napi]
    pub fn incoming_handshake_timeout_ms() -> u32 {
        10_000
    }

    /// Finish authentication within ten seconds without abandoning a native handshake.
    #[napi]
    pub async fn connect(&self) -> Result<Connection> {
        let inner = self
            .0
            .lock()
            .await
            .take()
            .ok_or_else(|| anyhow::anyhow!("Accepting already consumed"))?;
        // Keep a private close handle; never expose or use a stream before authentication.
        let accepting = inner.into_0rtt();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(Self::incoming_handshake_timeout_ms().into()),
            accepting.handshake_completed(),
        )
        .await;
        let conn = match result {
            Ok(Ok(conn)) => conn,
            Ok(Err(error)) => {
                accepting.close(0u32.into(), &[]);
                return Err(anyhow::anyhow!("{error:?}").into());
            }
            Err(_) => {
                accepting.close(0u32.into(), &[]);
                return Err(anyhow::anyhow!("incoming handshake exceeded 10 seconds").into());
            }
        };
        Ok(Connection(Arc::new(conn)))
    }
